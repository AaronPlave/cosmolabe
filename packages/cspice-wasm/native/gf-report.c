/*
   Progress-reporting, interruptible geometry-finder entry points.

   CSPICE ships two tiers of GF routines. The simplified wrappers the binding
   layer used until now -- gfdist_c, gfsep_c, gfposc_c, gfoclt_c -- hard-code
   "no progress report, no bail-out" and hand the search to the general-purpose
   routines underneath: gfevnt_c for the three quantity searches, gfocce_c for
   occultation. The general routines take the four handlers the wrappers refuse
   to expose:

     udrepi / udrepu / udrepf   progress report initialize / update / finish
     udbail                     polled during the search; true aborts it

   This file is the whole reason the general routines are reachable from
   JavaScript. Emscripten can call a JS function through a C function pointer,
   but only with -s ALLOW_TABLE_GROWTH and addFunction() at runtime -- a table
   that grows per call site and signatures asserted in JS rather than checked by
   a compiler. Compiling the handlers here instead keeps the signatures in C,
   where CSPICE declares them, and needs no function-pointer machinery at all:
   each handler is an ordinary static C function that calls out to JS via EM_JS.

   The four entry points below reproduce, parameter for parameter, the setup the
   f2c'd gfdist_/gfsep_/gfposc_/gfoclt_ perform before delegating -- the same
   quantity name, the same parameter-name/value arrays, the same step size
   through gfsstp_c, the same convergence tolerance. Nothing about the search
   changes; only the handlers do. packages/cspice-wasm/src/gf-reporting.test.ts
   is the proof: it runs both tiers over identical inputs and requires the
   windows to agree interval for interval.

   Convergence tolerance: the f2c'd wrappers read a tolerance stashed by
   gfstol_c and fall back to 1e-6 (SPICE_GF_CNVTOL). That store has no public
   reader, so `tol` is a parameter here and the binding layer passes
   SPICE_GF_CNVTOL. gfstol_c is not in the wasm export list, so no caller can
   make the two tiers disagree about it.
*/

#include <string.h>
#include <emscripten.h>
#include "SpiceUsr.h"

/* Fortran-side width of the GF quantity parameter name/value arrays. The f2c'd
   wrappers use 80-character entries; one more byte holds the C NUL. */
#define GFRPT_LENVALS 81

/* The most parameters any quantity below declares (gfposc: 10). */
#define GFRPT_MAXPARS 10

/* Confinement intervals tracked for the progress fraction. Cosmolabe searches a
   single interval; the cap only bounds how exact the fraction is for a window
   with more, and a search never fails for exceeding it. */
#define GFRPT_MAX_CNFINE 64

/* Minimum wall-clock gap between progress updates delivered to JS. A GF search
   calls udrepu far more often than a UI can use, and on the worker path every
   update is a postMessage. */
#define GFRPT_REPORT_MS 100.0

/* Minimum wall-clock gap between bail-out polls delivered to JS. Bounds both the
   cost of polling and how long a cancelled search keeps running. */
#define GFRPT_BAIL_MS 25.0

/* ------------------------------------------------------------------------- */
/* JS side of the handlers.                                                    */

EM_JS(void, gfrpt_js_progress, (double fraction, int pass), {
  if (Module["onGfProgress"]) Module["onGfProgress"](fraction, pass);
});

EM_JS(int, gfrpt_js_bail, (), {
  return (Module["onGfBail"] && Module["onGfBail"]()) ? 1 : 0;
});

/* ------------------------------------------------------------------------- */
/* Progress state. One search runs at a time: the module is single-threaded and
   every CSPICE call through it is synchronous, so a static here cannot be
   reentered. */

static SpiceDouble gfrptBeg[GFRPT_MAX_CNFINE];
static SpiceDouble gfrptEnd[GFRPT_MAX_CNFINE];
static SpiceInt    gfrptCount;
static SpiceDouble gfrptTotal;
static double      gfrptLastReport;
static double      gfrptLastBail;
static int         gfrptBailed;
static int         gfrptPass;

static void gfrpt_reset(void)
{
   gfrptCount      = 0;
   gfrptTotal      = 0.0;
   gfrptLastReport = 0.0;
   gfrptLastBail   = 0.0;
   gfrptBailed     = 0;
   gfrptPass       = 0;
}

/* udrepi: a pass is starting. Copy the window it will sweep, so udrepu can say
   how much of it is behind us. srcpre/srcsuf are the stock reporter's banner
   text; there is no banner here.

   A search runs in one or more passes -- a relational search over a quantity
   sweeps the confinement window once to find where the quantity is decreasing,
   then solves the relation over what that found -- and CSPICE reports each pass
   separately, against its own window. The pass number goes out with the fraction
   so a caller can tell a new pass starting from the search going backwards. */
static void gfrpt_repi(SpiceCell *cnfine, ConstSpiceChar *srcpre, ConstSpiceChar *srcsuf)
{
   SpiceInt  card;
   SpiceInt  i;

   (void) srcpre;
   (void) srcsuf;

   gfrptCount  = 0;
   gfrptTotal  = 0.0;
   gfrptPass  += 1;

   /* Read the cell's fields directly rather than through wnfetd_c: this runs
      inside CSPICE, and a nested call that signalled an error would corrupt the
      error state of the search that called us. */
   card = cnfine->card;

   for ( i = 0;  i + 1 < card && gfrptCount < GFRPT_MAX_CNFINE;  i += 2 )
   {
      SpiceDouble beg = SPICE_CELL_ELEM_D( cnfine, i     );
      SpiceDouble end = SPICE_CELL_ELEM_D( cnfine, i + 1 );

      gfrptBeg[gfrptCount] = beg;
      gfrptEnd[gfrptCount] = end;
      gfrptCount          += 1;

      if ( end > beg ) gfrptTotal += end - beg;
   }

   gfrptLastReport = emscripten_get_now();
   gfrpt_js_progress( 0.0, gfrptPass );
}

/* udrepu: the search has reached `et` within the confinement interval
   [ivbeg, ivend]. The fraction is of the confinement window searched, which is
   what CSPICE's own reporter reports -- it advances unevenly with wall-clock
   time and is honest as a bar, misleading as an ETA. */
static void gfrpt_repu(SpiceDouble ivbeg, SpiceDouble ivend, SpiceDouble et)
{
   SpiceDouble done = 0.0;
   SpiceDouble here;
   SpiceDouble fraction;
   double      now;
   SpiceInt    i;

   if ( gfrptTotal <= 0.0 ) return;

   now = emscripten_get_now();
   if ( now - gfrptLastReport < GFRPT_REPORT_MS ) return;
   gfrptLastReport = now;

   /* Everything strictly before the interval being searched is finished. */
   for ( i = 0;  i < gfrptCount;  i++ )
   {
      if ( gfrptEnd[i] <= ivbeg && gfrptEnd[i] > gfrptBeg[i] )
      {
         done += gfrptEnd[i] - gfrptBeg[i];
      }
   }

   here = et - ivbeg;
   if ( here < 0.0            ) here = 0.0;
   if ( here > ivend - ivbeg  ) here = ivend - ivbeg;
   done += here;

   fraction = done / gfrptTotal;
   if ( fraction < 0.0 ) fraction = 0.0;
   if ( fraction > 1.0 ) fraction = 1.0;

   gfrpt_js_progress( fraction, gfrptPass );
}

/* udrepf: a pass is over, by completion or by bail-out.

   Deliberately silent. Reporting 1.0 here would say "finished" once per pass,
   and a caller driving a progress bar off it would see the bar complete and
   then start over. The binding layer reports the single 1.0 that means the whole
   call is done, once it has actually returned. */
static void gfrpt_repf(void)
{
}

/* udbail: polled by the search; returning true aborts it and leaves `result`
   holding whatever had been found. Latched, because CSPICE polls again while it
   unwinds and the answer must not change underneath it. */
static SpiceBoolean gfrpt_bail(void)
{
   double now;

   if ( gfrptBailed ) return SPICETRUE;

   now = emscripten_get_now();
   if ( now - gfrptLastBail < GFRPT_BAIL_MS ) return SPICEFALSE;
   gfrptLastBail = now;

   if ( gfrpt_js_bail() )
   {
      gfrptBailed = 1;
      return SPICETRUE;
   }
   return SPICEFALSE;
}

/* ------------------------------------------------------------------------- */
/* Parameter-array helpers. gfevnt_c takes the quantity's parameter names and
   character values as [qnpars][lenvals] C string arrays. */

static SpiceChar gfrptNames [GFRPT_MAXPARS][GFRPT_LENVALS];
static SpiceChar gfrptValues[GFRPT_MAXPARS][GFRPT_LENVALS];
static SpiceDouble gfrptDouble[GFRPT_MAXPARS];
static SpiceInt    gfrptInt   [GFRPT_MAXPARS];
static SpiceBoolean gfrptLogical[GFRPT_MAXPARS];

/* Store one name/value pair. A value the caller left empty becomes a blank,
   which is what the f2c'd wrappers hand the Fortran layer for an unused
   parameter -- an empty C string is not the same thing to CSPICE's string
   mapper. Values wider than the Fortran field truncate, exactly as the
   simplified wrappers' s_copy does. */
static void gfrpt_param(SpiceInt slot, ConstSpiceChar *name, ConstSpiceChar *value)
{
   strncpy( gfrptNames[slot], name, GFRPT_LENVALS - 1 );
   gfrptNames[slot][GFRPT_LENVALS - 1] = '\0';

   if ( value == (ConstSpiceChar *) 0 || value[0] == '\0' )
   {
      strcpy( gfrptValues[slot], " " );
   }
   else
   {
      strncpy( gfrptValues[slot], value, GFRPT_LENVALS - 1 );
      gfrptValues[slot][GFRPT_LENVALS - 1] = '\0';
   }
}

static void gfrpt_clear_params(void)
{
   SpiceInt i;
   for ( i = 0; i < GFRPT_MAXPARS; i++ )
   {
      gfrptNames [i][0] = '\0';
      gfrptValues[i][0] = '\0';
      gfrptDouble[i]    = 0.0;
      gfrptInt   [i]    = 0;
      gfrptLogical[i]   = SPICEFALSE;
   }
}

/* The call every quantity search funnels into, once its parameter arrays are
   built. Mirrors the tail of the f2c'd wrappers: set the step size, then hand
   the search to gfevnt_c -- with reporting and bail-out on, which is the only
   difference. */
static void gfrpt_event(ConstSpiceChar *gquant,
                        SpiceInt        qnpars,
                        ConstSpiceChar *relate,
                        SpiceDouble     refval,
                        SpiceDouble     adjust,
                        SpiceDouble     step,
                        SpiceInt        nintvls,
                        SpiceDouble     tol,
                        SpiceCell      *cnfine,
                        SpiceCell      *result)
{
   gfrpt_reset();

   gfsstp_c ( step );
   if ( failed_c() ) return;

   gfevnt_c ( gfstep_c,
              gfrefn_c,
              gquant,
              qnpars,
              GFRPT_LENVALS,
              gfrptNames,
              gfrptValues,
              gfrptDouble,
              gfrptInt,
              gfrptLogical,
              relate,
              refval,
              tol,
              adjust,
              SPICETRUE,
              gfrpt_repi,
              gfrpt_repu,
              gfrpt_repf,
              nintvls,
              SPICETRUE,
              gfrpt_bail,
              cnfine,
              result );
}

/* ------------------------------------------------------------------------- */
/* Entry points. Each takes the arguments of the simplified wrapper it stands in
   for, plus the workspace interval count and the convergence tolerance the
   wrapper supplies internally. */

void gfrpt_dist(ConstSpiceChar *target,
                ConstSpiceChar *abcorr,
                ConstSpiceChar *obsrvr,
                ConstSpiceChar *relate,
                SpiceDouble     refval,
                SpiceDouble     adjust,
                SpiceDouble     step,
                SpiceInt        nintvls,
                SpiceDouble     tol,
                SpiceCell      *cnfine,
                SpiceCell      *result)
{
   gfrpt_clear_params();
   gfrpt_param( 0, "TARGET",   target );
   gfrpt_param( 1, "OBSERVER", obsrvr );
   gfrpt_param( 2, "ABCORR",   abcorr );

   gfrpt_event( "DISTANCE", 3, relate, refval, adjust, step, nintvls, tol,
                cnfine, result );
}

void gfrpt_sep(ConstSpiceChar *targ1,
               ConstSpiceChar *shape1,
               ConstSpiceChar *frame1,
               ConstSpiceChar *targ2,
               ConstSpiceChar *shape2,
               ConstSpiceChar *frame2,
               ConstSpiceChar *abcorr,
               ConstSpiceChar *obsrvr,
               ConstSpiceChar *relate,
               SpiceDouble     refval,
               SpiceDouble     adjust,
               SpiceDouble     step,
               SpiceInt        nintvls,
               SpiceDouble     tol,
               SpiceCell      *cnfine,
               SpiceCell      *result)
{
   gfrpt_clear_params();
   gfrpt_param( 0, "TARGET1",  targ1  );
   gfrpt_param( 1, "FRAME1",   frame1 );
   gfrpt_param( 2, "SHAPE1",   shape1 );
   gfrpt_param( 3, "TARGET2",  targ2  );
   gfrpt_param( 4, "FRAME2",   frame2 );
   gfrpt_param( 5, "SHAPE2",   shape2 );
   gfrpt_param( 6, "OBSERVER", obsrvr );
   gfrpt_param( 7, "ABCORR",   abcorr );

   gfrpt_event( "ANGULAR SEPARATION", 8, relate, refval, adjust, step, nintvls,
                tol, cnfine, result );
}

void gfrpt_posc(ConstSpiceChar *target,
                ConstSpiceChar *frame,
                ConstSpiceChar *abcorr,
                ConstSpiceChar *obsrvr,
                ConstSpiceChar *crdsys,
                ConstSpiceChar *coord,
                ConstSpiceChar *relate,
                SpiceDouble     refval,
                SpiceDouble     adjust,
                SpiceDouble     step,
                SpiceInt        nintvls,
                SpiceDouble     tol,
                SpiceCell      *cnfine,
                SpiceCell      *result)
{
   gfrpt_clear_params();
   gfrpt_param( 0, "TARGET",            target   );
   gfrpt_param( 1, "OBSERVER",          obsrvr   );
   gfrpt_param( 2, "ABCORR",            abcorr   );
   gfrpt_param( 3, "COORDINATE SYSTEM", crdsys   );
   gfrpt_param( 4, "COORDINATE",        coord    );
   gfrpt_param( 5, "REFERENCE FRAME",   frame    );
   /* A position search, so the vector is the observer-target position and the
      ray parameters DREF/DVEC go unused -- blank and zero, as gfposc_ sets
      them. */
   gfrpt_param( 6, "VECTOR DEFINITION", "POSITION" );
   gfrpt_param( 7, "METHOD",            " "        );
   gfrpt_param( 8, "DREF",              " "        );
   gfrpt_param( 9, "DVEC",              " "        );

   gfrpt_event( "COORDINATE", 10, relate, refval, adjust, step, nintvls, tol,
                cnfine, result );
}

/* Occultation searches go through gfocce_c rather than gfevnt_c: occultation is
   not one of gfevnt_c's quantities, and gfocce_c is the general routine
   gfoclt_c itself delegates to. */
void gfrpt_oclt(ConstSpiceChar *occtyp,
                ConstSpiceChar *front,
                ConstSpiceChar *fshape,
                ConstSpiceChar *fframe,
                ConstSpiceChar *back,
                ConstSpiceChar *bshape,
                ConstSpiceChar *bframe,
                ConstSpiceChar *abcorr,
                ConstSpiceChar *obsrvr,
                SpiceDouble     step,
                SpiceDouble     tol,
                SpiceCell      *cnfine,
                SpiceCell      *result)
{
   gfrpt_reset();

   gfsstp_c ( step );
   if ( failed_c() ) return;

   gfocce_c ( occtyp,
              front,
              fshape,
              fframe,
              back,
              bshape,
              bframe,
              abcorr,
              obsrvr,
              tol,
              gfstep_c,
              gfrefn_c,
              SPICETRUE,
              gfrpt_repi,
              gfrpt_repu,
              gfrpt_repf,
              SPICETRUE,
              gfrpt_bail,
              cnfine,
              result );
}
