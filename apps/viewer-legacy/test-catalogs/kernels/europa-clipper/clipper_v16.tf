KPL/FK


EUROPAM Frames Kernel
========================================================================

   This frame kernel contains the current set of frame definitions for
   the EUROPAM spacecraft including definitions for the EUROPAM
   mechanical structure frames, antenna frames, and science instrument
   frames.


Version and Date
========================================================================

   Version 1.6 -- December 8, 2020 -- Eric Ferguson

      Removed references to MASPEX radiator frame and object
      as no operational constraints are derived from its 
      position

   Version 1.5 -- June 24, 2020 -- Eric Ferguson

      Renamed UVS AP KOZ object and added another 
 
            EUROPAM_UVS_AP_KOZ         -159320  -> EUROPAM_UVS_AP_KOZ_10
            EUROPAM_UVS_AP_KOZ_20      -159321  -> added

   Version 1.4 -- June 24, 2020 -- Boris Semenov

      Replaced ICEMAG frames and name/ID mappings with ECM frames
      and name-ID mappings per [12] as follows for frames:

            EUROPAM_ICEMAG_MECH        -159400  ->  EUROPAM_ECM_MECH
            EUROPAM_ICEMAG_SVH1_MECH   -159401  ->  EUROPAM_ECM_FG1_MECH
            EUROPAM_ICEMAG_SVH1        -159402  ->  EUROPAM_ECM_FG1
            EUROPAM_ICEMAG_SVH2_MECH   -159403  ->  EUROPAM_ECM_FG2_MECH
            EUROPAM_ICEMAG_SVH2        -159404  ->  EUROPAM_ECM_FG2
            EUROPAM_ICEMAG_FG1_MECH    -159405  ->  EUROPAM_ECM_FG3_MECH
            EUROPAM_ICEMAG_FG1         -159406  ->  EUROPAM_ECM_FG3
            EUROPAM_ICEMAG_FG2_MECH    -159407  ->     deleted
            EUROPAM_ICEMAG_FG2         -159408  ->     deleted

      and as follows for name-ID mappings:

            EUROPAM_ICEMAG             -159400  ->  EUROPAM_ECM     
            EUROPAM_ICEMAG_SVH1        -159402  ->  EUROPAM_ECM_FG1
            EUROPAM_ICEMAG_SVH2        -159404  ->  EUROPAM_ECM_FG2
            EUROPAM_ICEMAG_FG1         -159406  ->  EUROPAM_ECM_FG3
            EUROPAM_ICEMAG_FG2         -159408  ->     deleted

      Renamed UVS AP KOZ object as follows 
 
            EUROPAM_UVS_KOZ            -159320  -> EUROPAM_UVS_AP_KOZ

      Added name-ID mapping for UVS SP KOZ

            EUROPAM_UVS_SP_KOZ         -159330

   Version 1.3 -- December 13, 2019 -- Boris Semenov

      Added name-ID mappings for E-THEMIS bands:

            EUROPAM_ETHEMIS_BAND1      -159210
            EUROPAM_ETHEMIS_BAND2      -159220
            EUROPAM_ETHEMIS_BAND3      -159230

   Version 1.2 -- October 2, 2019 -- Boris Semenov

      Swapped FBA2 and FBA3 frames alignments to be consistent with the
      official project nomenclature based on [11]

      Added FBA* name-ID mapping synonyms:

            EUROPAM_FBA-Y+Z            -159081
            EUROPAM_FBA-Y-Z            -159082
            EUROPAM_FBA+Y-Z            -159083

   Version 1.1 -- August 28, 2019 -- Boris Semenov

      Added name-ID mappings for ST1 and ST2 Sun Keep-Out Zones (KOZ)
      for Inner Cruise (IC), based on [10]:

            EUROPAM_ST1_KOZSUN_IC      -159036
            EUROPAM_ST2_KOZSUN_IC      -159037

   Version 1.0 -- August 26, 2019 -- Boris Semenov

      Updated EUROPAM_ST1 and EUROPAM_ST2 based on [9].

   Version 0.9 -- June 3, 2019 -- Boris Semenov

      Added the EUROPAM_ETHEMIS_RAD1/-159202 and
      EUROPAM_ETHEMIS_RAD2/-159203 frames and name/ID mappings, based
      on [8].

   Version 0.8 -- May 15, 2019 -- Boris Semenov

      Added the JUPITER_MEQUD and JUPITER_SUN_ORB frames; 'as is' 
      from [7]

   Version 0.7 -- April 1, 2019 -- Boris Semenov

      Reformatted LGA-Z related comments.

   Version 0.6 -- January 14, 2019/March 20, 2019 -- Steven Wissler,
                                                     Boris Semenov

      Added LGA-Z (Wissler, January 14, 2019)
 
      Updated EUROPAM_ST1 and EUROPAM_ST2 based on [6]. (Semenov, March
      20, 2019)

   Version 0.5 -- October 19, 2018 -- Boris Semenov

      Added EUROPAM_DSS-Y and EUROPAM_DSS+Y frames.

      Added name-ID mappings for DSS's and REASON VHF reference points:

            EUROPAM_DSS+Y            -159021
            EUROPAM_DSS-Y            -159022

            EUROPAM_DSS+Y_KOZ        -159023
            EUROPAM_DSS-Y_KOZ        -159024

            EUROPAM_REASON_VHF+X_I1  -159811
            EUROPAM_REASON_VHF+X_I2  -159812
            EUROPAM_REASON_VHF+X_I3  -159813
            EUROPAM_REASON_VHF+X_I4  -159814
            EUROPAM_REASON_VHF+X_I5  -159815
            EUROPAM_REASON_VHF+X_I6  -159816
            EUROPAM_REASON_VHF+X_I7  -159817

            EUROPAM_REASON_VHF-X_I1  -159841
            EUROPAM_REASON_VHF-X_I2  -159842
            EUROPAM_REASON_VHF-X_I3  -159843
            EUROPAM_REASON_VHF-X_I4  -159844
            EUROPAM_REASON_VHF-X_I5  -159845
            EUROPAM_REASON_VHF-X_I6  -159846
            EUROPAM_REASON_VHF-X_I7  -159847

   Version 0.4 -- September 6, 2018 -- Boris Semenov

      Added name-ID mappings for EIS WAC and NAC KOZs:

            EUROPAM_EIS_NAC_KOZ      -159112
            EUROPAM_EIS_WAC_KOZ      -159113

   Version 0.3 -- September 5, 2018 -- Boris Semenov

      Added name-ID mappings for the REASON HF+X and HF-X antenna tips
      (CS = Cell Side, NS = Non-cell Side):

            EUROPAM_REASON_HF+X_CS   -159831
            EUROPAM_REASON_HF+X_NS   -159832
            EUROPAM_REASON_HF-X_CS   -159861
            EUROPAM_REASON_HF-X_NS   -159862

   Version 0.2 -- May 23, 2018 -- Boris Semenov

      Added preliminary frame descriptions and diagrams.

      Redefined EUROPAM_EIS_WAC_RAD to be w.r.t. EUROPAM_EIS_WAC_MECH,
      consistent with [4]. This kept its +Z pointed in the same
      direction but rotated the frame by 180 degrees about it.
 
      Redefined EUROPAM_MASPEX_MECH to be consistent with [4]. This
      kept its +Z pointed in the same direction but rotated the frame
      by +90 degrees about it.
 
      Redefined EUROPAM_MASPEX_RAD for updated rotation of
      EUROPAM_MASPEX_MECH. This did not change its orientation w.r.t.
      the spacecraft frame.
 
      Redefined EUROPAM_SUDA to be consistent with [4]. This kept its +Z
      pointed in the same direction but rotated the frame by 180
      degrees about it.

      Added name-ID mappings for the EIS NAC and WAC filters and modes.

   Version 0.1 -- October 24, 2017 -- Boris Semenov

      Numerous updates to achieve a certain level of consistency with
      [4], including:

      -  added the following frames:

            EUROPAM_EIS_WAC_MECH     -159105
            EUROPAM_ETHEMIS_MECH     -159201
            EUROPAM_UVS_MECH         -159302
            EUROPAM_ICEMAG_MECH      -159400
            EUROPAM_ICEMAG_SVH1_MECH -159401
            EUROPAM_ICEMAG_SVH1      -159402
            EUROPAM_ICEMAG_SVH2_MECH -159403
            EUROPAM_ICEMAG_SVH2      -159404
            EUROPAM_ICEMAG_FG1_MECH  -159405
            EUROPAM_ICEMAG_FG1       -159406
            EUROPAM_ICEMAG_FG2_MECH  -159407
            EUROPAM_ICEMAG_FG2       -159408
            EUROPAM_MASPEX_MECH      -159502
            EUROPAM_MISE_MECH        -159602
            EUROPAM_PIMS_UPPER_MECH  -159704
            EUROPAM_PIMS_UPPER       -159705
            EUROPAM_PIMS_LOWER_MECH  -159706
            EUROPAM_PIMS_LOWER       -159707
            EUROPAM_REASON_VHF+X_I   -159801
            EUROPAM_REASON_VHF+X_O   -159802
            EUROPAM_REASON_HF+X      -159803
            EUROPAM_REASON_VHF-X_I   -159804
            EUROPAM_REASON_VHF-X_O   -159805
            EUROPAM_REASON_HF-X      -159806

      -  renamed the following frames:

            EUROPAM_ICEMAG           -159400  ->  EUROPAM_ICEMAG_MECH
            EUROPAM_PIMS_ANI_NADIR   -159703  ->  EUROPAM_PIMS_ANTI_NADIR

      -  changed IDs of the following frames:

            EUROPAM_SUDA             -159900  ->  -159150

      -  changed EUROPAM_UVS_SP to EUROPAM_UVS_AP offset from 60 to 40
         degrees (per [4] and ECR-2958).

      -  redefined many instrument frame chains to include the
         instruments *_MECH frame(s) while keeping the orientation of
         the instruments detector frames w.r.t. the spacecraft frame
         the same.

      -  replaced all _MATRIX-type alignments with _ANGLES-type alignments

      -  replaced angles in the EUROPAM_ST1 and EUROPAM_ST2 definitions
         with matrices from [4], resulting in nearly identical
         boresight directions compared to the previous FK versions but
         significantly different twists about boresights.

      -  added name-ID mappings for individual ICEMAG and REASON
         detectors:

            EUROPAM_ICEMAG_SVH1      -159402
            EUROPAM_ICEMAG_SVH2      -159404
            EUROPAM_ICEMAG_FG1       -159406
            EUROPAM_ICEMAG_FG2       -159408

            EUROPAM_REASON_VHF+X_I   -159801
            EUROPAM_REASON_VHF+X_O   -159802
            EUROPAM_REASON_HF+X      -159803
            EUROPAM_REASON_VHF-X_I   -159804
            EUROPAM_REASON_VHF-X_O   -159805
            EUROPAM_REASON_HF-X      -159806

      -  added frame trees for all sections

      -  reformatted comments

   Version 0.0 -- May 6, 2014 -- Eric Ferguson

      Pre-release. Frame layout of proposed instruments and solar
      arrays with some descriptions and diagrams not implemented.
 

References
========================================================================

   1. ``Frames Required Reading''

   2. ``Kernel Pool Required Reading''

   3. ``C-Kernel Required Reading''

   4. Europa_D-55714_3PCS_Volume_1_InitialRelease.pdf, October 2017

   5. ECR-9502_DSS_Head_Relocation_and_Accommodation_V03_Consolidated.pdf,
      10/19/18.

   6. ``Europa - Kernel Updates'', e-mail from Ben Bradley, 03/11/19

   7. ftp://spiftp.esac.esa.int/data/SPICE/JUICE/kernels/fk/juice_sci_v07.tf

   8. ECR-7560/APGEN Jira AP-395 (Add Radiator to +Y side of E_THEMIS)

   9. ECR-11770/Update to SRU Orientation Update and OPS Contstraints;
      ``ECR-11770 - Update to SRU Placement_v04_56-52 Consolodated.pptx'';
      08/14/19.

  10. APGEN Jira AP-778 (Add New SRU KOZ to SPICE Kernels for +/- 45
      deg for Inner Cruise)

  11. Europa_Telecom_FDD_D-56166_Baseline_Draft-Rev-_4-12-18-1.doc; 
      Figure 3-2

  12. C. Cochrane et al, ``Optimal Spacing of 3 Sensors on 8.5m Boom'',
      9 Bay Spacing option, 03/01/2020


Contact Information
========================================================================

   Eric W. Ferguson, JPL, (818)-634-1928, eric.w.ferguson@jpl.nasa.gov
   Boris V. Semenov, JPL, (818)-354-8136, boris.v.semenov@jpl.nasa.gov


Implementation Notes
========================================================================

   This file is used by the SPICE system as follows: programs that make
   use of this frame kernel must `load' the kernel, normally during
   program initialization. The SPICELIB routine FURNSH and CSPICE
   function furnsh_c load a kernel file into the kernel pool as shown
   below.

      CALL FURNSH ( 'frame_kernel_name' )
      furnsh_c    ( 'frame_kernel_name' )

   This file was created and may be updated with a text editor or word
   processor.      


EUROPAM Frames Summary
========================================================================
      
   The following EUROPAM frames are defined in this kernel file:

           Name                      Relative to            Type    NAIF ID
      =========================  =========================  =====   =======

   Generic Dynamic Frames
   ---------------------------------------
      JUPITER_MEQUD              J2000                      DYN     500599000
      JUPITER_SUN_ORB            J2000                      DYN     500599002

   EUROPAM Target Frames:
   ---------------------------------------
      IAU_EUROPA                 J2000                      PCK     10024  (1)
      IAU_GANYMEDE               J2000                      PCK     10025  (1)
      IAU_CALLISTO               J2000                      PCK     10026  (1)
   
   EUROPAM Body and Structures frames: 
   ---------------------------------------
      EUROPAM_SPACECRAFT         J2000                      CK      -159000
      EUROPAM_SA_BASE            EUROPAM_SPACECRAFT         FIXED   -159010
      EUROPAM_SA+X               EUROPAM_SA_BASE            CK      -159011
      EUROPAM_SA-X               EUROPAM_SA_BASE            CK      -159012
      EUROPAM_DSS+Y              EUROPAM_SPACECRAFT         FIXED   -159021
      EUROPAM_DSS-Y              EUROPAM_SPACECRAFT         FIXED   -159022
      EUROPAM_ST1                EUROPAM_SPACECRAFT         FIXED   -159030
      EUROPAM_ST2                EUROPAM_SPACECRAFT         FIXED   -159031
      EUROPAM_LGA+Y              EUROPAM_SPACECRAFT         FIXED   -159050
      EUROPAM_LGA-Y              EUROPAM_SPACECRAFT         FIXED   -159051
      EUROPAM_LGA-Z              EUROPAM_SPACECRAFT         FIXED   -159052
      EUROPAM_MGA                EUROPAM_SPACECRAFT         FIXED   -159060
      EUROPAM_HGA                EUROPAM_SPACECRAFT         FIXED   -159070
      EUROPAM_FBA1               EUROPAM_SPACECRAFT         FIXED   -159081
      EUROPAM_FBA2               EUROPAM_SPACECRAFT         FIXED   -159082
      EUROPAM_FBA3               EUROPAM_SPACECRAFT         FIXED   -159083
      EUROPAM_RADIATOR           EUROPAM_SPACECRAFT         FIXED   -159090

   EIS frames:
   ----------------------------------------     
      EUROPAM_EIS_NAC_BASE       EUROPAM_SPACECRAFT         FIXED   -159100
      EUROPAM_EIS_NAC_CTG        EUROPAM_EIS_NAC_BASE       CK      -159101
      EUROPAM_EIS_NAC_ATG        EUROPAM_EIS_NAC_CTG        CK      -159102
      EUROPAM_EIS_NAC            EUROPAM_EIS_NAC_ATG        FIXED   -159103
      EUROPAM_EIS_WAC_MECH       EUROPAM_SPACECRAFT         FIXED   -159105
      EUROPAM_EIS_WAC            EUROPAM_EIS_WAC_MECH       FIXED   -159104
      EUROPAM_EIS_WAC_RAD        EUROPAM_SPACECRAFT         FIXED   -159111

      
   E-THEMIS frames:
   ----------------
      EUROPAM_ETHEMIS_MECH       EUROPAM_SPACECRAFT         FIXED   -159201
      EUROPAM_ETHEMIS            EUROPAM_ETHEMIS_MECH       FIXED   -159200
      EUROPAM_ETHEMIS_RAD1       EUROPAM_ETHEMIS_MECH       FIXED   -159202
      EUROPAM_ETHEMIS_RAD2       EUROPAM_ETHEMIS_MECH       FIXED   -159203
      
   UVS frames:
   ----------------------------------------
      EUROPAM_UVS_MECH           EUROPAM_SPACECRAFT         FIXED   -159302
      EUROPAM_UVS_AP             EUROPAM_UVS_MECH           FIXED   -159300
      EUROPAM_UVS_SP             EUROPAM_UVS_AP             FIXED   -159301
      EUROPAM_UVS_RAD            EUROPAM_UVS_MECH           FIXED   -159310
         
   ECM frames:
   ----------------------------------------
      EUROPAM_ECM_MECH           EUROPAM_SPACECRAFT         FIXED   -159400
      EUROPAM_ECM_FG1_MECH       EUROPAM_ECM_MECH           FIXED   -159401
      EUROPAM_ECM_FG1            EUROPAM_ECM_FG1_MECH       FIXED   -159402
      EUROPAM_ECM_FG2_MECH       EUROPAM_ECM_MECH           FIXED   -159403
      EUROPAM_ECM_FG2            EUROPAM_ECM_FG2_MECH       FIXED   -159404
      EUROPAM_ECM_FG3_MECH       EUROPAM_ECM_MECH           FIXED   -159405
      EUROPAM_ECM_FG3            EUROPAM_ECM_FG3_MECH       FIXED   -159406
      
   MASPEX frames:
   ----------------------------------------
      EUROPAM_MASPEX_MECH        EUROPAM_SPACECRAFT         FIXED   -159502
      EUROPAM_MASPEX             EUROPAM_MASPEX_MECH        FIXED   -159500
      
   MISE frames:
   ----------------------------------------
      EUROPAM_MISE_MECH          EUROPAM_SPACECRAFT         FIXED   -159602
      EUROPAM_MISE_BASE          EUROPAM_MISE_MECH          FIXED   -159600
      EUROPAM_MISE               EUROPAM_MISE_BASE          CK      -159601
      EUROPAM_MISE_RAD1          EUROPAM_MISE_MECH          FIXED   -159610
      EUROPAM_MISE_RAD2          EUROPAM_MISE_MECH          FIXED   -159611
      
   PIMS frames:
   ----------------------------------------
      EUROPAM_PIMS_UPPER_MECH    EUROPAM_SPACECRAFT         FIXED   -159704
      EUROPAM_PIMS_UPPER         EUROPAM_PIMS_UPPER_MECH    FIXED   -159705
      EUROPAM_PIMS_RAM           EUROPAM_PIMS_UPPER         FIXED   -159700
      EUROPAM_PIMS_ANTI_NADIR    EUROPAM_PIMS_UPPER         FIXED   -159703
      EUROPAM_PIMS_LOWER_MECH    EUROPAM_SPACECRAFT         FIXED   -159706
      EUROPAM_PIMS_LOWER         EUROPAM_PIMS_LOWER_MECH    FIXED   -159707
      EUROPAM_PIMS_ANTI_RAM      EUROPAM_PIMS_LOWER         FIXED   -159701
      EUROPAM_PIMS_NADIR         EUROPAM_PIMS_LOWER         FIXED   -159702
      
      
   REASON frames:
   ----------------------------------------
      EUROPAM_REASON             EUROPAM_SPACECRAFT         FIXED   -159800
      EUROPAM_REASON_VHF+X_I     EUROPAM_SA+X               FIXED   -159801
      EUROPAM_REASON_VHF+X_O     EUROPAM_SA+X               FIXED   -159802
      EUROPAM_REASON_HF+X        EUROPAM_SA+X               FIXED   -159803
      EUROPAM_REASON_VHF-X_I     EUROPAM_SA-X               FIXED   -159804
      EUROPAM_REASON_VHF-X_O     EUROPAM_SA-X               FIXED   -159805
      EUROPAM_REASON_HF-X        EUROPAM_SA-X               FIXED   -159806
      
   SUDA frames:
   ----------------------------------------
      EUROPAM_SUDA               EUROPAM_SPACECRAFT         FIXED   -159150
         
   (1) These IAU_* frames are built into the Toolkit starting with the
       Toolkit version N0054 (June 2010).


Generic Dynamic Frames
========================================================================

   This sections defined generic dynamic frames of interest to EUROPAM.


Jupiter Mean Equator of Date Frame (JUPITER_MEQUD)
------------------------------------------------------------------------

   This frame definition was coped 'as is' from [7].


   Definition:
   -----------

   The Jupiter mean equator of date frame is defined as follows:

      -  X-Y plane is defined by Jupiter equator of date, with
         the +Z axis, the primary vector, parallel to Jupiter rotation
         axis of date, pointing toward the North side of the
         invariable plane;

      -  +X axis is the component of the ascending node of Jupiter
         equator of date on the Earth Mean Equator of J2000
         orthogonal to the +Z axis;

      -  +Y axis completes the right-handed system;

      -  the origin of this frame is the center of mass of Jupiter.

   All vectors are geometric: no aberration corrections are used.


   Required Data:
   --------------

   This frame is defined as a two-vector frame using constant vectors
   as the specification method.

   The primary vector is defined as a constant vector in the
   IAU_JUPITER body-fixed frame, which is a PCK-based frame. Therefore,
   a PCK file containing the orientation constants for Jupiter must be
   loaded before using this frame.

   The secondary vector is defined in the J2000 reference frame and
   therefore it does not require any additional data.


   Remarks:
   --------

   This frame is defined based on the IAU_JUPITER frame, whose
   evaluation is based on the data included in the loaded PCK file:
   different orientation constants for the spin axis of Jupiter will
   lead to a different frame orientation at a given time.

   This frame is provided as the ``most generic'' Jupiter mean
   equator of date frame since the user has the possibility of loading
   different Jupiter orientation constants that would help to
   define different implementations of this frame.

   It is strongly recommended to indicate what data have been used
   in the evaluation of this frame when referring to it, e.g.
   JUPITER_MEQUD using the IAU 2009 constants.

  \begindata

      FRAME_JUPITER_MEQUD              =  500599000
      FRAME_500599000_NAME             = 'JUPITER_MEQUD'
      FRAME_500599000_CLASS            =  5
      FRAME_500599000_CLASS_ID         =  500599000
      FRAME_500599000_CENTER           =  599
      FRAME_500599000_RELATIVE         = 'J2000'
      FRAME_500599000_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_500599000_FAMILY           = 'TWO-VECTOR'
      FRAME_500599000_PRI_AXIS         = 'Z'
      FRAME_500599000_PRI_VECTOR_DEF   = 'CONSTANT'
      FRAME_500599000_PRI_FRAME        = 'IAU_JUPITER'
      FRAME_500599000_PRI_SPEC         = 'RECTANGULAR'
      FRAME_500599000_PRI_VECTOR       = ( 0, 0, 1 )
      FRAME_500599000_SEC_AXIS         = 'Y'
      FRAME_500599000_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_500599000_SEC_FRAME        = 'J2000'
      FRAME_500599000_SEC_SPEC         = 'RECTANGULAR'
      FRAME_500599000_SEC_VECTOR       = ( 0, 0, 1 )

  \begintext


Jupiter Orbital Frame (JUPITER_SUN_ORB)
------------------------------------------------------------------------

   This frame definition was coped 'as is' from [7].

   Definition:
   -----------

   The Jupiter orbital frame is defined as follows:

      -  +X axis is the position of the Sun relative to Jupiter; it's
         the primary vector and points from Jupiter to Sun;

      -  +Y axis is the component of the inertially referenced
         velocity of Sun relative to Jupiter orthogonal to the +X axis;

      -  +Z axis completes the right-handed system;

      -  the origin of this frame is the center of mass of Jupiter.

   All vectors are geometric: no aberration corrections are used.


   Required Data:
   --------------

   This frame is defined as a two-vector frame using two different
   types of specifications for the primary and secondary vectors.

   The primary vector is defined as an 'observer-target position' 
   vector and the secondary vector is defined as an 'observer-target
   velocity' vector, therefore, the ephemeris data required to compute
   the Jupiter-Sun state vector in the J2000 reference frame must be
   loaded before using this frame.


   Remarks:
   --------

   This frame is defined based on SPK data: different planetary
   ephemerides for Jupiter, Sun and the Sun Barycenter
   will lead to a different frame orientation at a given time.

   It is strongly recommended to indicate what data have been used
   in the evaluation of this frame when referring to it, e.g.
   JUPITER_SUN_ORB using the DE405 ephemeris.

  \begindata

      FRAME_JUPITER_SUN_ORB            =  500599002
      FRAME_500599002_NAME             = 'JUPITER_SUN_ORB'
      FRAME_500599002_CLASS            =  5
      FRAME_500599002_CLASS_ID         =  500599002
      FRAME_500599002_CENTER           =  599
      FRAME_500599002_RELATIVE         = 'J2000'
      FRAME_500599002_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_500599002_FAMILY           = 'TWO-VECTOR'
      FRAME_500599002_PRI_AXIS         = 'X'
      FRAME_500599002_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_500599002_PRI_OBSERVER     = 'JUPITER'
      FRAME_500599002_PRI_TARGET       = 'SUN'
      FRAME_500599002_PRI_ABCORR       = 'NONE'
      FRAME_500599002_SEC_AXIS         = 'Y'
      FRAME_500599002_SEC_VECTOR_DEF   = 'OBSERVER_TARGET_VELOCITY'
      FRAME_500599002_SEC_OBSERVER     = 'JUPITER'
      FRAME_500599002_SEC_TARGET       = 'SUN'
      FRAME_500599002_SEC_ABCORR       = 'NONE'
      FRAME_500599002_SEC_FRAME        = 'J2000'

  \begintext


EUROPAM Spacecraft and Spacecraft Structures Frames
========================================================================

   This section of the file contains the definitions of the spacecraft
   and spacecraft structures frames.


EUROPAM Spacecraft and Spacecraft Structures Frame Tree
-------------------------------------------------------

   The diagram below shows the frame hierarchy of the EUROPAM
   spacecraft and its structure frames (not including science
   instrument frames.)

      "JUPITER_MEQUD"                                    "JUPITER_SUN_ORB"
      ---------------                                    -----------------
           ^                                                     ^
           |                                                     |
           |<-dynamic                                            |<-dynamic
           |                                                     |
           |                   "J2000" INERTIAL                  |
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |
                                      |
                                      |
                      "EUROPAM_DSS+Y" |
                      --------------- |
                                    ^ |
                                    | |
                             fixed->| |
                                    | |
                    "EUROPAM_DSS-Y" | |              "EUROPAM_LGA-Z"
                    --------------- | |              ---------------
                                  ^ | |                      ^
                                  | | |                      |<-fixed
                           fixed->| | |                      |
                                  | | |                      |
        "EUROPAM_RADIATOR"        | | |      "EUROPAM_LGA+Y" | "EUROPAM_LGA-Y" 
        ------------------        | | |      --------------- | ---------------
              ^                   | | |              ^       |       ^
              |                   | | |              |       |       |
              |<-fixed            | | |<-ck   fixed->|       |       |<-fixed
              |                   | | |              |       |       |
              |                       V              |       |       |
              |             "EUROPAM_SPACECRAFT"     |       |       |
              +------------------------------------------------------+
              |                   | | . | | |        |               |
              |<-fixed            | | . | | |        |               |
              |                   | | . | | |        |               |
              V                   | | . | | |        |               |
        "EUROPAM_SA_BASE"         | | . | | |        |               |
        -----------------         | | . | | |        |               |
          |           |           | | . | | |        |               |
          |<-ck       |<-ck       | | . | | |        |<-fixed        |<-fixed
          |           |           | | . | | |        |               |
          V           V           | | . | | |        V               V
    "EUROPAM_SA+X" "EUROPAM_SA-X" | | . | | |    EUROPAM_MGA"   "EUROPAM_HGA"
    -------------  -------------  | | . | | |    ------------   -------------
                                  | | . | | |
                           fixed->| | . | | |<-fixed
                                  | | . | | |
                                  V | . | | V
                     "EUROPAM_ST1"  | . | | "EUROPAM_FBA1"
                     -------------  | . | | --------------
                                    | . | |
                             fixed->| . | |<-fixed
                                    | . | |
                                    V . | V
                        "EUROPAM_ST2" . | "EUROPAM_FBA2"
                        ------------- . | --------------
                                      . |
                                      . |<-fixed
                                      . |
                                      . V
                                      . "EUROPAM_FBA3"
                                      . --------------
                                      .
                                      V
                Individual instrument frame trees are provided
                     in the other sections of this file


EUROPAM Spacecraft Frame
------------------------

   The EUROPAM spacecraft frame -- EUROPAM_SPACECRAFT -- is defined as
   follows:

      -  Origin = The X-Y plane is defined as the interface between the
         Spacecraft and Launch Vehicle. The origin is at the center of
         the circle of the Spacecraft to Launch Vehicle Separation
         Interface. (TBR unique specification)
 
      -  XSC = The X-axis completes the right-handed frame, nominally
         parallel to the long axis of the solar arrays
 
      -  YSC = The Y-axis emanates from the origin and is pointed
         towards the direction of nadir pointed instruments
 
      -  ZSC = The Z-axis is normal to the X and Y axes directed from
         the LVA toward the spacecraft body and is nominally parallel
         to the launch vehicle centerline.

   These diagrams illustrate the EUROPAM_SPACECRAFT frame:

      +Xsc view
      ---------
                                      ^
                                      | Velocity @CA
                                      |

                                         MASPEX
                              . SUDA      .-.    ..  UVS  
               PIMS/UPPER     | .-.       | | .-'|/  
                     .--.     |--------------'  ||==  EIS WAC
                     `--.`-.  |               .-||= 
                      -- `. `-|          MISE | ||  E-THEMIS
                     .| \  `. |       ..      `-|||
              HGA   / |  \   `|       ||        |||----.
                   /  |   \   |       ||      .-|||    | EIS NAC
                  /   |    \  `-------||-----'  |||----'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            Nadir @CA
                 \    |     /   |     o     |    ||              ----->
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    || HRSrad
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `'
                                |     ||    |    
                            .===|     ||    |    
    REASON/HF (x2, on SAs) //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--' PIMS/LOWER
              ..--''         `------- o--------->
        ..--''                    +Xsc |       +Ysc
     -''                               |
        ECM Boom                      .|
                                      || REASON/VHF (x4, on SAs)
                                      `'

                                                      +Xsc is out of
                                                          the page
      +Ysc view 1
      -----------

                                      ^
                                      | Velocity @CA
                                      |

                              .-----------------.
                              |        .-----.  | Instrument 
                              |        |     |  |    Deck
                                       |     |  |
                             '       `  |   |   |
         ------------.       |-------|  |   |   |      .------------
                 .    |      |       |  |   |   |     |    .
                 .    `      |       |  |   |   |     '    .
                 .     |     |       |   ----.--     |     .
                 .     `     `-------'       |       '     .
                 .      |      |             |      |      .
                 .      `      |             |      '      .
                 .       |     |             |     |       .
                 .       `     |             |     '       .
                 .        |    |             |    |        .
                 .        `  .-----------------.  '        .
                 .         | |                 | |         .
         +X SA   .         o=|                 |=o         .  -X SA
                 .         | |                 | |         .
                 .        .  |                 |  .        .
                 .        |  |                 |  |        .
                 .       .   |                 |   .       .
                 .       |   |                 |   |       .
                 .      .    |         +Zsc    |    .      .
                 .      |    `------- ^ -------'    |      .
                 .     .        |     |     |        .     .
                 .     |        |     |     |        |     .
                 .    .         |     |     |         .    .
                 .    |      .------- | -------.      |    .
         ------------'       |        |        |      `-------------
                            <---------o  ------'
                          +Xsc         +Ysc   
                                                      +Ysc and Nadir @CA
                                                      are out of the page


      +Ysc view 2
      -----------
                                      ^
                                      | Velocity @CA
                                      |

                               Instrument Deck 

                                   .-----.
     .--------------------------.  |-- --|  .--------------------------.
     | .     .     .     .     . \ |         .     .     .     .     . |
     | .     .     .     .     .  `|   +Zsc  .     .     .     .     . |
     | .     .     .     .     .  ||  ^      .     .     .     .     . |
     | .     .     .     .     .  o=  |  =o  .     .     .     .     . |
     | .     .     .     .     .  ||  |  ||  .     .     .     .     . |
     | .     .     .     .     .  .|  |  |`  .     .     .     .     . |
     | .     .     .     .     . / |  |  | \ .     .     .     .     . |
     `--------------------------'  /--|--\  `--------------------------'
        ==^==               <---------o --'   ==^==             ==^==
                          +Xsc         +Ysc   

                              Propulsion Module
                                                      +Ysc and Nadir @CA
                                                      are out of the page

      +Z view
      -------
                                    .---.   
                                 .-`     `-. HGA
                                 `-.     .-'
                                   .-----.
                                   |   +Zsc
     --*-----*-----*-----*  <---------o  =o--*-----*-----*-----*-----*--
                          +Xsc     |  | _|
                                   `--|._| Instrument
                                      |       Desk
                                      |
                                      |
                                      V
                                       +Ysc

                                      |
                                      | Nadir @CA
                                      v

                                                     +Zsc and Velocity @CA
                                                       are out of the page

   The EUROPAM_SPACECRAFT frame is defined below as a CK-based frame.
   
   \begindata

      FRAME_EUROPAM_SPACECRAFT         = -159000
      FRAME_-159000_NAME               = 'EUROPAM_SPACECRAFT'
      FRAME_-159000_CLASS              = 3
      FRAME_-159000_CLASS_ID           = -159000
      FRAME_-159000_CENTER             = -159
      CK_-159000_SCLK                  = -159
      CK_-159000_SPK                   = -159

   \begintext


EUROPAM Solar Array Frames
--------------------------

   Since the EUROPAM solar arrays can be articulated (each having one
   degree of freedom), the solar Array frames, EUROPAM_SA+X and
   EUROPAM_SA-X, are defined as CK frames with their orientation given
   relative to the EUROPAM_SA_BASE frame. The EUROPAM_SA_BASE frame is
   a fixed offset frame defined relative to the EUROPAM_SPACECRAFT
   frame, establishing the solar arrays zero position.

   The EUROPAM_SA_BASE frame is defined as follows:

      -  +X axis is parallel the array's rotation axis and is nominally
         co-aligned with the spacecraft +X axis;

      -  +Z axis is nominally co-aligned with the spacecraft -Y axis;

      -  +Y axis is defined such that (X,Y,Z) is right handed;

      -  the origin of the frame is located at the intersection of the 
         array rotation axis and the spacecraft central axis.

      -  NOTE: this definition is different from the definition of the
         SA non-rotating frames (SA_nXnr_mech) provided in [4], which
         are defined to be co-aligned with the spacecraft frame.

      -  this frame is nominally rotated from the EUROPAM_SPACECRAFT
         frame by +90 degrees about X.

   Both array frames -- EUROPAM_SA+X and EUROPAM_SA-X -- are defined as
   follows:

      -  +Z axis is normal to the solar array plane, the solar cells
         facing +Z;

      -  +X axis is parallel to the longest side of the array
         and the array's rotation axis, and is nominally co-aligned
         with the spacecraft +X axis;

      -  +Y axis is defined such that (X,Y,Z) is right handed;

      -  the origin of the frame is located at the center of the 
         array shaft mounting hole pattern.

      -  NOTE: this definition is different from the definition of the
         SA rotating frames (SA_nXrot_mech) provided in [4], which have
         the -Y axis aligned with the solar cell side normal.

   These diagrams illustrate the EUROPAM_SA_BASE, EUROPAM_SA+X, and
   EUROPAM_SA-X frames for both arrays in zero position:
 
      +Ysc view
      ---------
                                   +Ysa_base
                                    
                           +Ysa+x ^   ^   ^ +Ysa-x
                                  |.--|--.|
     .--------------------------. ||--|--|| .--------------------------.
     | .     .     .     .     . \||  |   |  .     .     .     .     . |
     | .     .                    ||+Zsc  |  .     .     .     .     . |
     | .     .     +Xsa+x   +Xsa-x||  ^   |  .     .     .     .     . |
     | .     .          <---<---<-*---*---*  .     .     .     .     . |
     | .     .         +Xsa_base  ||  |  ||  .     .     .     .     . |
     | .     .                    .|  |  |`  .     .     .     .     . |
     | .     .     .     .     . / |  |  | \ .     .     .     .     . |
     `--------------------------'  /--|--\  `--------------------------'
        ==^==               <---------o --'   ==^==             ==^==
                          +Xsc         +Ysc   

                              Propulsion Module
                                                   +Ysc is out of the page.

                                                  +Zsa_base, +Zsa+x, +Zsa-x
                                                      are into the page.
      +Zsc view
      ---------
                                   +Zsa_base

                           +Zsa+x ^   ^   ^ +Zsa-x
                                  | .-|-. | 
                                 .|`  |  `|. 
                                 `|.  |  .|' HGA
                                  |.--|--.|  
                  +Xsa+x   +Xsa-x ||  |  ||
     --*-----*----      <---<---<-o---o---o--*-----*-----*-----*-----*--
                          +Xsc     |  |+Zsc
                        +Xsa_base  `--|._| Instrument
                                      |       Desk
                                      |
                                      |
                                      V
                                       +Ysc
                                                  +Ysa_base, +Ysa+x, +Ysa-x
                                                    and +Zsc are out of
                                                         the page

   The sets of keywords below define the solar array frames.

   \begindata
   
      FRAME_EUROPAM_SA_BASE            = -159010
      FRAME_-159010_NAME               = 'EUROPAM_SA_BASE'
      FRAME_-159010_CLASS              = 4
      FRAME_-159010_CLASS_ID           = -159010
      FRAME_-159010_CENTER             = -159
      TKFRAME_-159010_SPEC             = 'ANGLES'
      TKFRAME_-159010_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159010_ANGLES           = ( 0.0, -90.0, 0.0 )
      TKFRAME_-159010_AXES             = ( 3, 1, 2 )
      TKFRAME_-159010_UNITS            = 'DEGREES'

      FRAME_EUROPAM_SA+X               = -159011
      FRAME_-159011_NAME               = 'EUROPAM_SA+X'
      FRAME_-159011_CLASS              = 3
      FRAME_-159011_CLASS_ID           = -159011
      FRAME_-159011_CENTER             = -159
      CK_-159011_SCLK                  = -159
      CK_-159011_SPK                   = -159

      FRAME_EUROPAM_SA-X               = -159012
      FRAME_-159012_NAME               = 'EUROPAM_SA-X'
      FRAME_-159012_CLASS              = 3
      FRAME_-159012_CLASS_ID           = -159012
      FRAME_-159012_CENTER             = -159
      CK_-159012_SCLK                  = -159
      CK_-159012_SPK                   = -159


   \begintext
   

EUROPAM Digital Sun Sensor Frames
---------------------------------

   The EUROPAM digital sun sensor frames -- EUROPAM_DSS+Y and
   EUROPAM_DSS-Y -- are defined as follows:

      -  +Z axis is co-aligned with the sensor boresight;
 
      -  +X axis is along the s/c +X axis;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the sensor's center.

   This diagram illustrates the digital sun sensor frames (based on
   [5]):

      +Xsc view
      ---------
                         ^ +Ydss-y
       +Zdss-y <        /                  
                `.     /      .           .-.    ..     
           25 deg `.  /       | .-.       | | .-'|/  
               ---- `o--.     |--------------'  ||==   
                     `--.`-.  |               .-||= 
                      -- `. `-|               | ||   
                     .| \  `. |       ..      `-|||
              HGA   / |  \   `|       ||        |||----.
                   /  |   \   |       ||      .-|||    | 
                  /   |    \  `-------||-----'  |||----'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            
                 \    |     /   |     o     |    ||              
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||  
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `'
                                |     ||    |    
                            .===|     ||    |    
                           //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--o.-------
              ..--''         `------- o--------->/  `-.  8.5 deg
        ..--''                    +Xsc |    +Ysc/      `> 
     -''                               |       /         +Zdss+y
                                      .|      v
                                      ||       +Xdss+y
                                      `'

                                             +Xsc, +Xdss+y, and +Xdss-y
                                                 are out of the page

   The digital sun sensor frames are defined below as fixed-offset
   frames.

   \begindata

      FRAME_EUROPAM_DSS+Y              = -159021
      FRAME_-159021_NAME               = 'EUROPAM_DSS+Y'
      FRAME_-159021_CLASS              = 4
      FRAME_-159021_CLASS_ID           = -159021
      FRAME_-159021_CENTER             = -159
      TKFRAME_-159021_SPEC             = 'ANGLES'
      TKFRAME_-159021_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159021_ANGLES           = ( 0.0, 98.5, 0.0 )
      TKFRAME_-159021_AXES             = ( 3, 1, 2 )
      TKFRAME_-159021_UNITS            = 'DEGREES'

      FRAME_EUROPAM_DSS-Y              = -159022
      FRAME_-159022_NAME               = 'EUROPAM_DSS-Y'
      FRAME_-159022_CLASS              = 4
      FRAME_-159022_CLASS_ID           = -159022
      FRAME_-159022_CENTER             = -159
      TKFRAME_-159022_SPEC             = 'ANGLES'
      TKFRAME_-159022_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159022_ANGLES           = ( 0.0, -65.0, 0.0 )
      TKFRAME_-159022_AXES             = ( 3, 1, 2 )
      TKFRAME_-159022_UNITS            = 'DEGREES'
      
   \begintext


EUROPAM Star Tracker Frames
---------------------------

   The EUROPAM star tracker frames -- EUROPAM_ST1 and EUROPAM_ST2 --
   are defined as follows:

      -  +Z axis is co-aligned with the tracker boresight;
 
      -  +X axis is along the tracker CCD rows (TBD);
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the tracker CCD central
         pixel.

   This diagram illustrates the star tracker frames:

      +Ysc view
      ---------
                             +Zst1                 +Zst2
                                  ^                ^ 
                                   \ +Xst1  +Xst2 /  
                                    \    .><.    /  .> 
                                     \ .'    `. /.-'  +Yst2
                                      *.       *'
                              .-------- `>  ----.
                              |                 | Instrument 
                              |        +Yst1    |    Deck
                                                |
                             '       `  |   |   |
         ------------.       |-------|  |   |   |      .------------
                 .    |      |       |  |   |   |     |    .
                 .    `      |       |  |   |   |     '    .
                 .     |     |       |   ----.--     |     .
                 .     `     `-------'       |       '     .
                 .      |      |             |      |      .
                 .      `      |             |      '      .
                 .       |     |             |     |       .
                 .       `     |             |     '       .
                 .        |    |             |    |        .
                 .        `  .-----------------.  '        .
                 .         | |                 | |         .
         +X SA   .         o=|                 |=o         .  -X SA
                 .         | |                 | |         .
                 .        .  |                 |  .        .
                 .        |  |                 |  |        .
                 .       .   |                 |   .       .
                 .       |   |                 |   |       .
                 .      .    |         +Zsc    |    .      .
                 .      |    `------- ^ -------'    |      .
                 .     .        |     |     |        .     .
                 .     |        |     |     |        |     .
                 .    .         |     |     |         .    .
                 .    |      .------- | -------.      |    .
         ------------'       |        |        |      `-------------
                            <---------o  ------'
                          +Xsc         +Ysc   
                                                  +Zst1 and +Zst2 are approx.
                                                    30 deg below the page.

                                                     +Xst1, +Xst2 and +Yst2 
                                                       are above the page.

                                                    +Yst1 is below the page.

                                                    +Ysc is out of the page.


   The following star tracker frame DCMs were provided in [4] (for the
   ``40/37'' design) and used in the FK versions 0.1-0.5:

      ST1:
                     X st1               Y st1               Z st1
        X sc   0.858177539300657  -0.000000000000000   0.513353008211572 
        Y sc   0.365966692835327   0.701270986557205  -0.611790309786170 
        Z sc  -0.359999570520638   0.712894805292537   0.601815009626606  

      ST2:
                     X st2               Y st2               Z st2
        X sc   0.858177539300657  -0.000000000000000  -0.513353008211572 
        Y sc  -0.365966692835327   0.701270986557205  -0.611790309786170 
        Z sc   0.359999570520638   0.712894805292537   0.601815009626606

   According to [6] the GNC and Mechanical are leaning toward the
   ``50/46'' star tracker design going forward, where ``50'' is the
   rotation about the s/c +Z axis off the s/c -Y and ``46'' is the
   elevation off the s/c XY plane. This design places ST1 boresight at
   AZ = -40 deg and EL = +46 deg and ST2 boresight at AZ = -140 deg and
   EL = +46 deg in the s/c frame. Assuming these boresight directions
   and constraining the +Y axes of the tracker frames to be parallel to
   the s/c YZ plane, we get the following star tracker frame DCMs that 
   were used in the FK versions 0.6-0.9:

      ST1:
                     X st1               Y st1               Z st1
        X sc   0.846656889335853  -0.000000000000000   0.532139184556199
        Y sc   0.280644517884015   0.849623748887139  -0.446517793496085
        Z sc  -0.452118088912383   0.527389310971472   0.719339800338651


      ST2:
                     X st2               Y st2               Z st2
        X sc   0.846656889335853   0.000000000000000  -0.532139184556199
        Y sc  -0.280644517884015   0.849623748887139  -0.446517793496086
        Z sc   0.452118088912383   0.527389310971472   0.719339800338651

   According to [9] the star tracker frame DCMs for the new approved 
   56/52 configuration are:

      ST1:
                     X st1               Y st1               Z st1
        X sc  -0.80514752004      -0.30203092691       0.51040649502
        Y sc   0.13052802395      -0.92975167272      -0.34427352794
        Z sc   0.57853254527      -0.21056862603       0.78801075361

      ST2:
                     X st2               Y st2               Z st2
        X sc   0.740468400000     -0.437254798080     -0.510406495020
        Y sc   0.289994693626      0.892960702174     -0.344273527942
        Z sc   0.606308194132      0.106908493250      0.788010753607 


   The transposes of these matrices were incorporated into the frame
   definitions below.
 
   The star tracker frames are defined below as fixed-offset frames.

   \begindata

      FRAME_EUROPAM_ST1                = -159030
      FRAME_-159030_NAME               = 'EUROPAM_ST1'
      FRAME_-159030_CLASS              = 4
      FRAME_-159030_CLASS_ID           = -159030
      FRAME_-159030_CENTER             = -159
      TKFRAME_-159030_SPEC             = 'MATRIX'
      TKFRAME_-159030_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159030_MATRIX           = ( 

              -0.80514752004       0.13052802395       0.57853254527
              -0.30203092691      -0.92975167272      -0.21056862603
               0.51040649502      -0.34427352794       0.78801075361

                                         )

      FRAME_EUROPAM_ST2                = -159031
      FRAME_-159031_NAME               = 'EUROPAM_ST2'
      FRAME_-159031_CLASS              = 4
      FRAME_-159031_CLASS_ID           = -159031
      FRAME_-159031_CENTER             = -159
      TKFRAME_-159031_SPEC             = 'MATRIX'
      TKFRAME_-159031_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159031_MATRIX           = ( 

               0.740468400000      0.289994693626      0.606308194132
              -0.437254798080      0.892960702174      0.106908493250
              -0.510406495020     -0.344273527942      0.788010753607

                                         )

   \begintext

   
EUROPAM Low Gain Antenna Frames
-------------------------------

   The EUROPAM low gain antenna frames -- EUROPAM_LGA+Y, EUROPAM_LGA-Y
   and EUROPAM_LGA-Z -- are defined as follows:

      -  +Z axis is co-aligned with the antenna boresight;
 
      -  +X axis is along the antenna pattern clock reference
         direction (TBD);
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the 
         antenna's outer rim.

      -  NOTE: this definition is different from the definition of the
         LGA mechanical frames (LGA_xY_mech) provided in [4], which has
         the -Y axis aligned with the antenna boresight.

   This diagram illustrates the low gain antenna frames:

      +Xsc view
      ---------
                     ^ +Ylga-y
                     |                    
                     |        .           .-.    ..     
                     |        | .-.       | | .-'|/  
               <-----o--.     |--------------'  ||==   
         +Zlga-y     `--.`-.  |               .-||= 
                      -- `. `-|               | ||   
                     .| \  `. |       ..      `-|||
              HGA   / |  \   `|       ||        |||----.
                   /  |   \   |       ||      .-|||    | 
                  /   |    \  `-------||-----'  |||----'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            
                 \    |     /   |     o     |    ||              
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||  
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `'
                                |     ||    |    
                            .===|     ||    |    
               +Ylga-z     //   |     ||    |                  
     ============  <.  == //=.------- ||-------.====================== 
                     `-.   / |        |.       |--o-----> +Zlga+y
              ..--''    `-o  `------- o---------> |
        ..--''           /        +Xsc |    +Ysc  |
     -''                /              |          |
                       /              .|          v
                      v +Zlga-z       ||            +Ylga+y
                                      `'

                                                +Xsc, +Xlga+y, +Xlga-y, and
                                                +Xlga-z are out of the page

   The low gain antenna frames are defined below as fixed-offset
   frames.

   \begindata

      FRAME_EUROPAM_LGA+Y              = -159050
      FRAME_-159050_NAME               = 'EUROPAM_LGA+Y'
      FRAME_-159050_CLASS              = 4
      FRAME_-159050_CLASS_ID           = -159050
      FRAME_-159050_CENTER             = -159
      TKFRAME_-159050_SPEC             = 'ANGLES'
      TKFRAME_-159050_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159050_ANGLES           = ( 0.0, 90.0, 0.0 )
      TKFRAME_-159050_AXES             = ( 3, 1, 2 )
      TKFRAME_-159050_UNITS            = 'DEGREES'

      FRAME_EUROPAM_LGA-Y              = -159051
      FRAME_-159051_NAME               = 'EUROPAM_LGA-Y'
      FRAME_-159051_CLASS              = 4
      FRAME_-159051_CLASS_ID           = -159051
      FRAME_-159051_CENTER             = -159
      TKFRAME_-159051_SPEC             = 'ANGLES'
      TKFRAME_-159051_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159051_ANGLES           = ( 0.0, -90.0, 0.0 )
      TKFRAME_-159051_AXES             = ( 3, 1, 2 )
      TKFRAME_-159051_UNITS            = 'DEGREES'
      
      FRAME_EUROPAM_LGA-Z              = -159052
      FRAME_-159052_NAME               = 'EUROPAM_LGA-Z'
      FRAME_-159052_CLASS              = 4
      FRAME_-159052_CLASS_ID           = -159052
      FRAME_-159052_CENTER             = -159
      TKFRAME_-159052_SPEC             = 'ANGLES'
      TKFRAME_-159052_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159052_ANGLES           = ( 195.0, 0.0, 0.0 )
      TKFRAME_-159052_AXES             = ( 1, 2, 3 )
      TKFRAME_-159052_UNITS            = 'DEGREES'
      
   \begintext


EUROPAM Medium Gain Antenna Frame
---------------------------------

   The EUROPAM medium gain antenna frame -- EUROPAM_MGA -- is defined
   as follows:

      -  +Z axis is co-aligned with the antenna boresight;
 
      -  +X axis is along the antenna pattern clock reference
         direction (TBD);
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the 
         antenna's outer rim.

      -  NOTE: this definition is different from the definition of the
         MGA mechanical frame (MGA_mech) provided in [4], which has the
         -Y axis aligned with the antenna boresight.

   This diagram illustrates the medium gain antenna frame:

      +Xsc view
      ---------
                     ^ +Ymga
                     |                    
                     |        .           .-.    ..     
                     |        | .-.       | | .-'|/  
               <-----o--.     |--------------'  ||==   
         +Zmga       `--.`-.  |               .-||= 
                      -- `. `-|               | ||   
                     .| \  `. |       ..      `-|||
              HGA   / |  \   `|       ||        |||----.
                   /  |   \   |       ||      .-|||    | 
                  /   |    \  `-------||-----'  |||----'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            
                 \    |     /   |     o     |    ||              
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||  
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `'
                                |     ||    |    
                            .===|     ||    |    
                           //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--'
              ..--''         `------- o--------->  
        ..--''                    +Xsc |    +Ysc   
     -''                               |           
                                      .|           
                                      ||           
                                      `'
                                                +Xsc and +Xmga are 
                                                 out of the page

   The medium gain antenna frame is defined below as a fixed-offset
   frame.


   \begindata

      FRAME_EUROPAM_MGA                = -159060
      FRAME_-159060_NAME               = 'EUROPAM_MGA'
      FRAME_-159060_CLASS              = 4
      FRAME_-159060_CLASS_ID           = -159060
      FRAME_-159060_CENTER             = -159
      TKFRAME_-159060_SPEC             = 'ANGLES'
      TKFRAME_-159060_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159060_ANGLES           = ( 0.0, -90.0, 0.0 )
      TKFRAME_-159060_AXES             = ( 3, 1, 2 )
      TKFRAME_-159060_UNITS            = 'DEGREES'
      
   \begintext


EUROPAM High Gain Antenna Frame
-------------------------------

   The EUROPAM high gain antenna frame -- EUROPAM_HGA -- is defined as
   follows:

      -  +Z axis is co-aligned with the antenna boresight;
 
      -  +X axis is along the antenna pattern clock reference
         direction (TBD);
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the antenna's focal 
         point.

      -  NOTE: that this definition is different from the definition of
         the HGA KA mechanical frame (KA_mech) provided in [4], which
         has the -Y axis aligned with the antenna boresight.

   This diagram illustrates the high gain antenna frame:

                              .           .-.    ..     
                              | .-.       | | .-'|/  
                     .--.     |--------------'  ||==   
                     `--.`-.  |               .-||= 
                      -- `. `-|               | ||   
                     .| \  `. |       ..      `-|||
              HGA   / |  \   `|       ||        |||----.
                   /  |   \   |       ||      .-|||    | 
                  /   |    \  `-------||-----'  |||----'
                 /    ^ +Yhga   |     ||    |   ||| 
                /     |         |     ||    |   `'
               /      |       `-|     ||    |    
                      |       | |     ||    |    
                <-----o       | |     ||    |    
            +Zhga             | |     ||    |    
                      |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            
                 \    |     /   |     o     |    ||              
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||  
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `'
                                |     ||    |    
                            .===|     ||    |    
                           //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--'
              ..--''         `------- o--------->  
        ..--''                    +Xsc |    +Ysc   
     -''                               |           
                                      .|           
                                      ||           
                                      `'
                                                +Xsc and +Xhga are 
                                                 out of the page

   The high gain antenna frame is defined below as a fixed-offset frame.

   \begindata

      FRAME_EUROPAM_HGA                = -159070
      FRAME_-159070_NAME               = 'EUROPAM_HGA'
      FRAME_-159070_CLASS              = 4
      FRAME_-159070_CLASS_ID           = -159070
      FRAME_-159070_CENTER             = -159
      TKFRAME_-159070_SPEC             = 'ANGLES'
      TKFRAME_-159070_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159070_ANGLES           = ( 0.0, -90.0, 0.0 )
      TKFRAME_-159070_AXES             = ( 3, 1, 2 )
      TKFRAME_-159070_UNITS            = 'DEGREES'
      
   \begintext


EUROPAM Fanbeam Antenna Frames
------------------------------

   The EUROPAM fanbeam antenna frames -- EUROPAM_FBA1, EUROPAM_FBA2, and
   EUROPAM_FBA3 -- are defined as follows:

      -  +Z axis is co-aligned with the antenna boresight;
 
      -  +X axis is along the center-line of the antenna FOV wide 
         dimension;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the antenna's outer 
         assembly center point.

      -  NOTE: this definition is different from the definitions of the
         FBA mechanical frames (*FBA_brack) provided in [4], which do
         not align any particular axis with the boresight.

   These diagrams illustrate the fanbeam antenna frames:

      +Xsc view
      ---------

          +Zfba1           +Yfba1
                ^         ^                
                 `.     .'    .           .-.    ..     
                   `. .'      | .-.       | | .-'|/  
                     o--.     |--------------'  ||==   
                     `--.`-.  |               .-||= 
                      -- `. `-|               | ||   
                     .| \  `. |       ..      `-|||
              HGA   / |  \   `|       ||        |||----.
                   /  |   \   |       ||      .-|||    | 
                  /   |    \  `-------||-----'  |||----'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            
                 \    |     /   |     o     |    ||              
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||  
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `'
                                |     ||    |    
               +Yfba2       .===|     ||    |    
                     ^     //   |     ||    |                  
     ===============  `.    =.------- ||-------.====================== 
                    ..  `. / |        |.    +Ysc -\
              ..--''      o  `------- o--------->  o
        ..--''          .'        +Xsc |         .' `.
     -''              .'               |       .'     `.
                     V                .|      V         V
               +Zfba2                 || +Yfba3          +Zfba3           
                                      `'
                                                +Xsc and +Xfba* are 
                                                   out of the page

   The fanbeam antenna frames are defined below as fixed-offset frames.

   \begindata

      FRAME_EUROPAM_FBA1               = -159081
      FRAME_-159081_NAME               = 'EUROPAM_FBA1'
      FRAME_-159081_CLASS              = 4
      FRAME_-159081_CLASS_ID           = -159081
      FRAME_-159081_CENTER             = -159
      TKFRAME_-159081_SPEC             = 'ANGLES'
      TKFRAME_-159081_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159081_ANGLES           = ( 0.0, -45.0, 0.0 )
      TKFRAME_-159081_AXES             = ( 3, 1, 2 )
      TKFRAME_-159081_UNITS            = 'DEGREES'

      FRAME_EUROPAM_FBA2               = -159082
      FRAME_-159082_NAME               = 'EUROPAM_FBA2'
      FRAME_-159082_CLASS              = 4
      FRAME_-159082_CLASS_ID           = -159082
      FRAME_-159082_CENTER             = -159
      TKFRAME_-159082_SPEC             = 'ANGLES'
      TKFRAME_-159082_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159082_ANGLES           = ( 0.0, -135.0, 0.0 )
      TKFRAME_-159082_AXES             = ( 3, 1, 2 )
      TKFRAME_-159082_UNITS            = 'DEGREES'

      FRAME_EUROPAM_FBA3               = -159083
      FRAME_-159083_NAME               = 'EUROPAM_FBA3'
      FRAME_-159083_CLASS              = 4
      FRAME_-159083_CLASS_ID           = -159083
      FRAME_-159083_CENTER             = -159
      TKFRAME_-159083_SPEC             = 'ANGLES'
      TKFRAME_-159083_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159083_ANGLES           = ( 0.0, 135.0, 0.0 )
      TKFRAME_-159083_AXES             = ( 3, 1, 2 )
      TKFRAME_-159083_UNITS            = 'DEGREES'
      
   \begintext

    
EUROPAM Spacecraft Thermal Radiator
-----------------------------------
    
   The EUROPAM spacecraft thermal radiator frame -- EUROPAM_RADIATOR --
   is defined as follows:

      -  +Z axis is co-aligned with the normal to the radiator's outer 
         surface;
 
      -  +X axis is co-aligned with the spacecraft +X;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the 
         radiator's outer surface.

      -  NOTE: this definition is different from the definition of the
         Thermal Radiator frame (HRSrad) provided in [4], which has
         the +Y axis aligned with the normal to the radiator outer 
         surface.

   These diagrams illustrate the spacecraft thermal radiator frame:

      +Xsc view
      ---------
                              .           .-.    ..     
                              | .-.       | | .-'|/  
                     .--.     |--------------'  ||==   
                     `--.`-.  |               .-||= 
                      -- `. `-|               | ||   
                     .| \  `. |       ..      `-|||
              HGA   / |  \   `|       ||        |||----.
                   /  |   \   |       ||      .-|||    | 
                  /   |    \  `-------||-----'  |||----'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            
                 \    |     /   |     o     |    ||              
                  \   |    /    |     ||    |+Xrad|      +Zrad
                   \  |   /     |     ||    |    |o----->   
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.|V +Yrad
                                |     ^     |    ` 
                                |     ||    |    
                            .===|     ||    |    
                           //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--'
              ..--''         `------- o--------->  
        ..--''                    +Xsc |    +Ysc   
     -''                               |           
                                      .|           
                                      ||           
                                      `'
                                                +Xsc and +Xrad are 
                                                 out of the page

   The spacecraft thermal radiator frame is defined below as
   a fixed-offset frame.

   \begindata
    
      FRAME_EUROPAM_RADIATOR           = -159090
      FRAME_-159090_NAME               = 'EUROPAM_RADIATOR'
      FRAME_-159090_CLASS              = 4
      FRAME_-159090_CLASS_ID           = -159090
      FRAME_-159090_CENTER             = -159
      TKFRAME_-159090_SPEC             = 'ANGLES'
      TKFRAME_-159090_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159090_ANGLES           = ( 0.0, 90.0, 0.0 )
      TKFRAME_-159090_AXES             = ( 3, 1, 2 )
      TKFRAME_-159090_UNITS            = 'DEGREES'
        
   \begintext


EUROPAM Europa Imaging System (EIS) Frames
========================================================================
    
   This section of the file contains the definitions of the EIS frames.


EIS Frame Tree
--------------

   The diagram below shows the frame hierarchy of the EUROPAM EIS
   frames.

                               "J2000" INERTIAL
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |                               
                                      |<-ck
                                      |                               
                                      V                               
                            "EUROPAM_SPACECRAFT"                      
           +-----------------------------------------------------+
           |                          |                          |
           |<-fixed                   |<-fixed                   |<-fixed
           |                          |                          |
           V                          V                          V
     "EUROPAM_EIS_WAC_RAD"   "EUROPAM_EIS_NAC_BASE"   "EUROPAM_EIS_WAC_MECH"
     ---------------------   ----------------------   ----------------------
                                      |                          |
                                      |<-ck                      |<-fixed
                                      |                          |
                                      V                          V
                            "EUROPAM_EIS_NAC_CTG"        "EUROPAM_EIS_WAC"
                            ---------------------        -----------------
                                      |
                                      |<-ck         
                                      |             
                                      V             
                            "EUROPAM_EIS_NAC_ATG"     
                            ---------------------
                                      |
                                      |<-fixed       
                                      |             
                                      V             
                              "EUROPAM_EIS_NAC"     
                              -----------------

                                
EIS NAC frames
--------------

   The EUROPAM EIS NAC frame chain includes four frames --
   EUROPAM_EIS_NAC_BASE, EUROPAM_EIS_NAC_CTG, EUROPAM_EIS_NAC_ATG, and
   EUROPAM_EIS_NAC.

   The EIS NAC base frame -- EUROPAM_EIS_NAC_BASE -- is defined as follows:
 
      -  +Z axis is nominally co-aligned with the spacecraft +Y axis,
         and with the camera boresight when both gimbals are at the
         zero position;
 
      -  +Y axis is nominally co-aligned with the spacecraft +Z axis
         and is nominally parallel to the cross track gimbal rotation
         axis;
 
      -  +X axis is defined such that (X,Y,Z) is right handed and is
         nominally parallel to the along track gimbal rotation axis
         when both gimbals are at the zero position;
 
      -  the origin of the frame is located at the intersection of the
         cross track and along track gimbal rotation axes;
 
      -  this frame is defined as a fixed offset frame with respect to
         the spacecraft frame.
 
   The EIS NAC cross track gimbal (CTG) frame -- EUROPAM_EIS_NAC_CTG --
   is defined as follows:
 
      -  +Z axis is nominally co-aligned with the camera boresight when
         both gimbals are at the zero position;
 
      -  +Y axis is co-aligned with the EIS NAC base frame +Y axis and
         is nominally parallel to the cross track gimbal rotation axis;
 
      -  +X axis is defined such that (X,Y,Z) is right handed and is
         nominally parallel to the along track gimbal rotation axis;
 
      -  the origin of the frame is located at the intersection of the
         cross track and along track gimbal rotation axes;
 
      -  this frame rotates about +Y axis with respect to the EIS NAC
         base frame and is defined as a CK-based frame.
 
   The EIS NAC along track gimbal (ATG) frame -- EUROPAM_EIS_NAC_ATG --
   is defined as follows:
 
      -  +Z axis is nominally co-aligned with the camera boresight when
         both gimbals are at the zero position;
 
      -  +Y axis is nominally co-aligned with the EIS NAC CTG frame +Y
         axis when both gimbals are at the zero position;
 
      -  +X axis is defined such that (X,Y,Z) is right handed and is
         nominally parallel to the along track gimbal rotation axis;
 
      -  the origin of the frame is located at the intersection of the
         cross track and along track gimbal rotation axes;
 
      -  this frame rotates about +X axis with respect to the EIS NAC
         CTG frame and is defined as a CK-based frame.
 
   The EIS NAC optical frame -- EUROPAM_EIS_NAC -- is defined as follows:

      -  +Z axis is along the camera boresight;
 
      -  +Y axis is along the detector columns and nominally co-aligned
         with the EIS NAC ATG frame +Y axis;
 
      -  +X axis is defined such that (X,Y,Z) is right handed, is along
         the detector rows, and is nominally co-aligned with the EIS
         NAC ATG frame +X axis;
 
      -  the origin of the frame is located at the center of the camera
         CCD;
 
      -  this frame is defined as a fixed offset frame with respect to
         and is nominally co-aligned with the EIS NAC ATG frame.

   When both gimbals are at the zero position all four frames are
   nominally co-aligned.

   NOTE: while descriptions above are different from the descriptions
   of the NAC_mech, NAC_CTG, NAC_ATG, and NAC_opt frames provided in
   from [4], for all practical purposes the four frames from [4] and
   the four frames below are defined in the same way.

   These diagrams illustrate the EIS NAC frames for zero CTG and ATG 
   positions:

      +Xsc view
      ---------
                                      ^
                                      | Velocity @CA
                                      |
                                                   +Ybase
                              .           .-.    . +Yctg
                              | .-.       | | .-'| +Yatg  
                     .--.     |--------------'  |  +Ynac    
                     `--.`-.  |               .-| ^      +Zbase
                      -- `. `-|               | | |      +Zctg
                     .| \  `. |       ..      `-| |      +Zatg
              HGA   / |  \   `|       ||        | | ---. +Znac
                   /  |   \   |       ||      .-| x----->
                  /   |    \  `-------||-----'  ||  ---'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            Nadir @CA
                 \    |     /   |     o     |    ||              ----->
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `' 
                                |     ||    |    
                            .===|     ||    |    
                           //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--'
              ..--''         `------- o--------->  
        ..--''                    +Xsc |    +Ysc   
     -''                               |           
                                      .|           
                                      ||           
                                      `'
                                                +Xsc is out of the page

                                               +Xbase, +Xatg, +Xctg, and 
                                                +Xnac are into the page

      +Ysc view
      ---------
                                      ^
                                      | Velocity @CA
                                      |

                                          |
                                            CTG Rotation Axis
                                   +Ybase | 
                                    +Yctg
                              .---- +Yatg | ----.
                              |     +Ynac   -.  |
                              |           ^  |  |
                                       |  |  |  |
                             '       `  | | |   |
         ------------.       |------    | | |   |      ATG Rotation Axis
                 .    |      |            o-----> - - - - - - - - - - - -
                 .    `      |      +Znac   |   | +Xnac     
                 .     |     |      +Zatg  --.--  +Xatg    .
                 .     `     `----- +Zctg    |    +Xctg    .
                 .      |      |    +Zbase   |    +Xbase   .
                 .      `      |             |             .
                 .       |     |             |     |       .
                 .       `     |             |     '       .
                 .        |    |             |    |        .
                 .        `  .-----------------.  '        .
                 .         | |                 | |         .
         +X SA   .         o=|                 |=o         .  -X SA
                 .         | |                 | |         .
                 .        .  |                 |  .        .
                 .        |  |                 |  |        .
                 .       .   |                 |   .       .
                 .       |   |                 |   |       .
                 .      .    |         +Zsc    |    .      .
                 .      |    `------- ^ -------'    |      .
                 .     .        |     |     |        .     .
                 .     |        |     |     |        |     .
                 .    .         |     |     |         .    .
                 .    |      .------- | -------.      |    .
         ------------'       |        |        |      `-------------
                            <---------o  ------'
                          +Xsc         +Ysc   

                                                        Nadir @CA, +Ysc,
                                                  +Znac, +Zatg, +Zctg, and 
                                                  +Zbase are out of the page


   The EIS NAC frames are defined below.

   \begindata

      FRAME_EUROPAM_EIS_NAC_BASE       = -159100
      FRAME_-159100_NAME               = 'EUROPAM_EIS_NAC_BASE'
      FRAME_-159100_CLASS              = 4
      FRAME_-159100_CLASS_ID           = -159100
      FRAME_-159100_CENTER             = -159
      TKFRAME_-159100_SPEC             = 'ANGLES'
      TKFRAME_-159100_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159100_ANGLES           = ( 180, -90, 0 )
      TKFRAME_-159100_AXES             = ( 3, 1, 2 )
      TKFRAME_-159100_UNITS            = 'DEGREES'

      FRAME_EUROPAM_EIS_NAC_CTG        = -159101
      FRAME_-159101_NAME               = 'EUROPAM_EIS_NAC_CTG'
      FRAME_-159101_CLASS              = 3
      FRAME_-159101_CLASS_ID           = -159101
      FRAME_-159101_CENTER             = -159
      CK_-159101_SCLK                  = -159
      CK_-159101_SPK                   = -159

      FRAME_EUROPAM_EIS_NAC_ATG        = -159102
      FRAME_-159102_NAME               = 'EUROPAM_EIS_NAC_ATG'
      FRAME_-159102_CLASS              = 3
      FRAME_-159102_CLASS_ID           = -159102
      FRAME_-159102_CENTER             = -159
      CK_-159102_SCLK                  = -159
      CK_-159102_SPK                   = -159

      FRAME_EUROPAM_EIS_NAC            = -159103
      FRAME_-159103_NAME               = 'EUROPAM_EIS_NAC'
      FRAME_-159103_CLASS              = 4
      FRAME_-159103_CLASS_ID           = -159103
      FRAME_-159103_CENTER             = -159
      TKFRAME_-159103_SPEC             = 'ANGLES'
      TKFRAME_-159103_RELATIVE         = 'EUROPAM_EIS_NAC_ATG'
      TKFRAME_-159103_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159103_AXES             = ( 3, 1, 2 )
      TKFRAME_-159103_UNITS            = 'DEGREES'

   \begintext


EIS WAC frames
--------------

   The EUROPAM EIS WAC frames -- EUROPAM_EIS_WAC_MECH (mechanical),
   EUROPAM_EIS_WAC (optical), and EUROPAM_EIS_WAC_RAD (radiator) -- are
   defined as follows:

      -  +Z axis is along the camera boresight and nominally co-aligned
         with the spacecraft +Y axis;
 
      -  +Y axis is along the detector columns and nominally co-aligned
         with the spacecraft +Z axis;
 
      -  +X axis is defined such that (X,Y,Z) is right handed, is along
         the detector rows, and is nominally co-aligned with the
         spacecraft -X axis;
 
      -  the origin of the frame is located at the center of the camera
         CCD;
 
      -  the EUROPAM_EIS_WAC_MECH is defined as a fixed offset frame
         with respect to the spacecraft frame. The EUROPAM_EIS_WAC and
         EUROPAM_EIS_WAC_RAD are defined as fixed offset frames with
         respect to and are nominally co-aligned with the EIS WAC
         mechanical frame.

   These diagrams illustrate the EIS WAC frames:

      +Xsc view
      ---------
                                      ^
                         Velocity @CA |      +Yrad
                                      |      +Ymech
                                             +Ywac
                                                   ^
                                                   |
                              .           .-.    ..|
                              | .-.       | | .-'|/| 
                     .--.     |--------------'  ||=x----->
                     `--.`-.  |               .-||       +Zwac
                      -- `. `-|               | ||       +Zmech
                     .| \  `. |       ..      `-|||      +Zrad
              HGA   / |  \   `|       ||        ||| ---.
                   /  |   \   |       ||      .-|||    |
                  /   |    \  `-------||-----'  ||| ---'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            Nadir @CA
                 \    |     /   |     o     |    ||              ----->
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `' 
                                |     ||    |    
                            .===|     ||    |    
                           //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--'
              ..--''         `------- o--------->  
        ..--''                    +Xsc |    +Ysc   
     -''                               |           
                                      .|           
                                      ||           
                                      `'
                                                +Xsc is out of the page

                                               +Xmech, +Xwac, and +Xrad
                                                   are into the page

      +Ysc view
      ---------
                                      ^
                                      | Velocity @CA
                                      |

                                  +Yrad
                                 +Ymech
                                  +Ywac ^ 
                                        |
                              .-------  | ------.
                              |         | ---   |
                              |         o-----> |
                                  +Zwac       +Xwac
                             '   +Zmech |   | +Xmech
         ------------.       |--- +Zrad |   | +Xrad    .------------
                 .    |      |          |   |   |     |    .
                 .    `      |       |  |   |   |     '    .
                 .     |     |       |   ----.--     |     .
                 .     `     `-------'       |       '     .
                 .      |      |             |      |      .
                 .      `      |             |      '      .
                 .       |     |             |     |       .
                 .       `     |             |     '       .
                 .        |    |             |    |        .
                 .        `  .-----------------.  '        .
                 .         | |                 | |         .
         +X SA   .         o=|                 |=o         .  -X SA
                 .         | |                 | |         .
                 .        .  |                 |  .        .
                 .        |  |                 |  |        .
                 .       .   |                 |   .       .
                 .       |   |                 |   |       .
                 .      .    |         +Zsc    |    .      .
                 .      |    `------- ^ -------'    |      .
                 .     .        |     |     |        .     .
                 .     |        |     |     |        |     .
                 .    .         |     |     |         .    .
                 .    |      .------- | -------.      |    .
         ------------'       |        |        |      `-------------
                            <---------o  ------'
                          +Xsc         +Ysc   

                                                        Nadir @CA, +Ysc,
                                                   +Zmech, +Zwac, and +Zrad
                                                      are out of the page

   The EIS WAC frames are defined below as fixed offset frames.

   \begindata

      FRAME_EUROPAM_EIS_WAC_MECH       = -159105
      FRAME_-159105_NAME               = 'EUROPAM_EIS_WAC_MECH'
      FRAME_-159105_CLASS              = 4
      FRAME_-159105_CLASS_ID           = -159105
      FRAME_-159105_CENTER             = -159
      TKFRAME_-159105_SPEC             = 'ANGLES'
      TKFRAME_-159105_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159105_ANGLES           = ( 180, -90, 0 )
      TKFRAME_-159105_AXES             = ( 3, 1, 2 )
      TKFRAME_-159105_UNITS            = 'DEGREES'

      FRAME_EUROPAM_EIS_WAC            = -159104
      FRAME_-159104_NAME               = 'EUROPAM_EIS_WAC'
      FRAME_-159104_CLASS              = 4
      FRAME_-159104_CLASS_ID           = -159104
      FRAME_-159104_CENTER             = -159
      TKFRAME_-159104_SPEC             = 'ANGLES'
      TKFRAME_-159104_RELATIVE         = 'EUROPAM_EIS_WAC_MECH'
      TKFRAME_-159104_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159104_AXES             = ( 3, 1, 2 )
      TKFRAME_-159104_UNITS            = 'DEGREES'

      FRAME_EUROPAM_EIS_WAC_RAD        = -159111
      FRAME_-159111_NAME               = 'EUROPAM_EIS_WAC_RAD'
      FRAME_-159111_CLASS              = 4
      FRAME_-159111_CLASS_ID           = -159111
      FRAME_-159111_CENTER             = -159
      TKFRAME_-159111_SPEC             = 'ANGLES'
      TKFRAME_-159111_RELATIVE         = 'EUROPAM_EIS_WAC_MECH'
      TKFRAME_-159111_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159111_AXES             = ( 3, 1, 2 )
      TKFRAME_-159111_UNITS            = 'DEGREES'
        
   \begintext
    

EUROPAM Europa Thermal Emission Imaging System (E-THEMIS) Frames
========================================================================

   This section of the file contains the definitions of the E-THEMIS 
   frames.


E-THEMIS Frame Tree
-------------------

   The diagram below shows the frame hierarchy of the EUROPAM E-THEMIS
   frames.

                               "J2000" INERTIAL
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |                               
                                      |<-ck
                                      |                               
                                      V                               
                            "EUROPAM_SPACECRAFT"                      
                            --------------------
                                      |             
                                      |<-fixed      
                                      |               
                                      V              
                            "EUROPAM_ETHEMIS_MECH"   
           +-----------------------------------------------------+
           |                          |                          |
           |                          |<-fixed                   |<-fixed
           |                          |                          |
           V                          V                          V
      "EUROPAM_ETHEMIS_RAD1"  "EUROPAM_ETHEMIS"   "EUROPAM_ETHEMIS_RAD2"
      ----------------------  -----------------   ----------------------


E-THEMIS Frames
---------------
    
   The EUROPAM E-THEMIS frame tree includes four frames --
   EUROPAM_ETHEMIS_MECH, EUROPAM_ETHEMIS, EUROPAM_ETHEMIS_RAD1, and 
   EUROPAM_ETHEMIS_RAD2.

   The EUROPAM E-THEMIS mechanical frame -- EUROPAM_ETHEMIS_MECH -- is
   defined as a fixed offset frame with respect to and is nominally
   co-aligned with the spacecraft frame.
 
   The EUROPAM E-THEMIS optical frame -- EUROPAM_ETHEMIS -- is defined
   as follows:

      -  +Z axis is along the instrument boresight and nominally
         co-aligned with the spacecraft +Y axis;
 
      -  +X axis is along the detector rows and is nominally co-aligned
         with the spacecraft +X axis;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the instrument detector
         center;
 
      -  the EUROPAM_ETHEMIS frame is defined as a fixed offset frame
         with respect to the E-THEMIS mechanical frame and is nominally 
         rotated from it by -90 degrees about X.

      -  NOTE: this definition is different from the definition of the
         E-Themis line-of-sight frame (ETHEMIS_los) provided in [4],
         which has the +Y axis aligned with the instrument boresight.

   The EUROPAM E-THEMIS radiator frames -- EUROPAM_ETHEMIS_RAD1 and 
   EUROPAM_ETHEMIS_RAD2 -- are defined as follows:

      -  +Z axis is along the normal to the radiator outer surface;
 
      -  +X axis is nominally co-aligned with the spacecraft +X axis;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the
         radiator outer surface;
 
      -  the radiator frames are defined as fixed offset frames with
         respect to the E-THEMIS mechanical frame, with the RAD1 frame
         nominally rotated from it by -111.16 degrees about X, and the
         RAD2 frame nominally rotated from it by -103.90 degrees about
         X. (NOTE: these rotations are based on the following radiator
         normal directions specified in [8]: "A1: 0i + 0.93j - 0.36k 
         and A2: 0i + 0.97j - 0.24k")

   These diagrams illustrate the E-THEMIS frames:

      +Xsc view
      ---------
                                      ^
                         Velocity @CA |
                                      |
                                            +Zmech
                                                   ^
                                                   |
                              .           .-.    ..|       +Ymech
                              | .-.       | | .-'|/|       +Zethemis
                     .--.     |--------------'  ||=o----->
                     `--.`-.  |               .-|| |`-.`-> +Zethemis_rad2
                      -- `. `-|               | || |   `-> +Zethemis_rad1
                     .| \  `. |       ..      `-|| |       
              HGA   / |  \   `|       ||        || v
                   /  |   \   |       ||      .-||| +Yethemis
                  /   |    \  `-------||-----'  |||
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            Nadir @CA
                 \    |     /   |     o     |    ||              ----->
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `' 
                                |     ||    |    
                            .===|     ||    |    
                           //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--'
              ..--''         `------- o--------->  
        ..--''                    +Xsc |    +Ysc   
     -''                               |           
                                      .|           
                                      ||           
                                      `'
                                              +Xsc, +Xmech, +Xethemis,
                                         +Xethemis_rad1 and +Xethemis_rad2
                                                   are out of the page

                                         +Yethemis_rad1 and +Yethemis_rad2
                                                    are not shown.

      +Ysc view
      ---------
                                      ^
                                      | Velocity @CA
                                      |

                                 +Zmech
                                        ^ 
                                        |
                              .-------  | ------.
                              |         | ---.  |
                                  <-----o    |  |
                          +Xethemis     v    |  |
                             +Xmech     v   |   |
         ----------- +Xethemis_rad1     |      .------------
                 .   +Xethemis_rad2  |  v +Yethemis   |    .
                 .                   |          |     '    .
                 .     |     |       |    ---.--     |     .
                 .     `     `-------'       |       '     .
                 .      |      |             |      |      .
                 .      `      |             |      '      .
                 .       |     |             |     |       .
                 .       `     |             |     '       .
                 .        |    |             |    |        .
                 .        `  .-----------------.  '        .
                 .         | |                 | |         .
         +X SA   .         o=|                 |=o         .  -X SA
                 .         | |                 | |         .
                 .        .  |                 |  .        .
                 .        |  |                 |  |        .
                 .       .   |                 |   .       .
                 .       |   |                 |   |       .
                 .      .    |         +Zsc    |    .      .
                 .      |    `------- ^ -------'    |      .
                 .     .        |     |     |        .     .
                 .     |        |     |     |        |     .
                 .    .         |     |     |         .    .
                 .    |      .------- | -------.      |    .
         ------------'       |        |        |      `-------------
                            <---------o  ------'
                          +Xsc         +Ysc   

                                                        Nadir @CA, +Ysc,
                                                     +Ymech, and +Zethemis
                                                       are out of the page

                                         +Zethemis_rad1 is out of the page,
                                         tilted 21.16 degrees forward -Zsc.

                                         +Zethemis_rad2 is out of the page,
                                         tilted 13.90 degrees forward -Zsc.

                                         +Yethemis_rad1 and +Yethemis_rad2
                                                    are not shown.

   The E-THEMIS frames are defined below as fixed offset frames.

   \begindata

      FRAME_EUROPAM_ETHEMIS_MECH       = -159201
      FRAME_-159201_NAME               = 'EUROPAM_ETHEMIS_MECH'
      FRAME_-159201_CLASS              = 4
      FRAME_-159201_CLASS_ID           = -159201
      FRAME_-159201_CENTER             = -159
      TKFRAME_-159201_SPEC             = 'ANGLES'
      TKFRAME_-159201_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159201_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159201_AXES             = ( 3, 1, 2 )
      TKFRAME_-159201_UNITS            = 'DEGREES'

      FRAME_EUROPAM_ETHEMIS            = -159200
      FRAME_-159200_NAME               = 'EUROPAM_ETHEMIS'
      FRAME_-159200_CLASS              = 4
      FRAME_-159200_CLASS_ID           = -159200
      FRAME_-159200_CENTER             = -159
      TKFRAME_-159200_SPEC             = 'ANGLES'
      TKFRAME_-159200_RELATIVE         = 'EUROPAM_ETHEMIS_MECH'
      TKFRAME_-159200_ANGLES           = ( 0.0, 90.0, 0.0 )
      TKFRAME_-159200_AXES             = ( 3, 1, 2 )
      TKFRAME_-159200_UNITS            = 'DEGREES'
      
      FRAME_EUROPAM_ETHEMIS_RAD1       = -159202
      FRAME_-159202_NAME               = 'EUROPAM_ETHEMIS_RAD1'
      FRAME_-159202_CLASS              = 4
      FRAME_-159202_CLASS_ID           = -159202
      FRAME_-159202_CENTER             = -159
      TKFRAME_-159202_SPEC             = 'ANGLES'
      TKFRAME_-159202_RELATIVE         = 'EUROPAM_ETHEMIS_MECH'
      TKFRAME_-159202_ANGLES           = ( 0.0, 111.16, 0.0 )
      TKFRAME_-159202_AXES             = ( 3, 1, 2 )
      TKFRAME_-159202_UNITS            = 'DEGREES'
      
      FRAME_EUROPAM_ETHEMIS_RAD2       = -159203
      FRAME_-159203_NAME               = 'EUROPAM_ETHEMIS_RAD2'
      FRAME_-159203_CLASS              = 4
      FRAME_-159203_CLASS_ID           = -159203
      FRAME_-159203_CENTER             = -159
      TKFRAME_-159203_SPEC             = 'ANGLES'
      TKFRAME_-159203_RELATIVE         = 'EUROPAM_ETHEMIS_MECH'
      TKFRAME_-159203_ANGLES           = ( 0.0, 103.90, 0.0 )
      TKFRAME_-159203_AXES             = ( 3, 1, 2 )
      TKFRAME_-159203_UNITS            = 'DEGREES'
      
   \begintext


EUROPAM Ultraviolet Spectrograph (UVS) Frames
========================================================================

   This section of the file contains the definitions of the
   Ultraviolet Spectrograph (UVS) frames.
 

UVS Frame Tree
--------------

   The diagram below shows the frame hierarchy of the EUROPAM UVS
   frames.

                               "J2000" INERTIAL
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |                               
                                      |<-ck
                                      |                               
                                      V                               
                            "EUROPAM_SPACECRAFT"                      
                            --------------------
                                      |             
                                      |<-fixed      
                                      |               
                                      V              
                            "EUROPAM_UVS_MECH"   
                       +----------------------------+
                       |                            |
                       |<-fixed                     |<-fixed
                       |                            |
                       V                            V
                  "EUROPAM_UVS_AP"          "EUROPAM_UVS_RAD"          
                  ----------------          -----------------
                       |             
                       |<-fixed      
                       |               
                       V              
                  "EUROPAM_UVS_SP"   
                  ----------------


UVS Frames
----------
    
   The EUROPAM UVS frame chains include four frames --
   EUROPAM_UVS_MECH, EUROPAM_UVS_AP, EUROPAM_UVS_SP, and
   EUROPAM_UVS_RAD.

   The EUROPAM UVS mechanical frame -- EUROPAM_UVS_MECH -- is defined
   as follows:

      -  +X axis is along the airglow port boresight and nominally
         co-aligned with the spacecraft +Y axis;
 
      -  +Y axis is nominally co-aligned with the spacecraft -Z axis;
 
      -  +Z axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the intersection of 
         airglow and solar port boresights;
 
      -  this frame is defined as a fixed offset frame with respect 
         to the spacecraft frame.
 
   The EUROPAM UVS airglow port frame -- EUROPAM_UVS_AP -- is defined
   as follows:
 
      -  +Z axis is along the airglow port boresight and nominally
         co-aligned with the spacecraft +Y axis;
 
      -  +Y axis is nominally co-aligned with the UVS mechanical +Y
         axis;
 
      -  +X axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the intersection of 
         airglow and solar port boresights;
 
      -  this frame is defined as a fixed offset frame with respect 
         to the UVS mechanical frame.

      -  NOTE: this definition is different from the definition of the
         UVS airglow port line-of-sight frame (UVS_APILS) provided in
         [4], which has the +X axis aligned with the instrument
         boresight.
   
   The EUROPAM UVS solar port frame -- EUROPAM_UVS_SP -- is defined as
   follows:
 
      -  +Z axis is along the solar port boresight and nominally
         points 40 degrees off the spacecraft +Y axis, between the 
         spacecraft +Y and +Z axes;
 
      -  +X axis is nominally co-aligned with the airglow port +X axis;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the intersection of 
         airglow and solar port boresights;
 
      -  this frame is defined as a fixed offset frame with respect 
         to the airglow port frame.

      -  NOTE: this definition is different from the definition of the
         UVS solar port line-of-sight frame (UVS_SPILS) provided in
         [4], which has the +X axis aligned with the instrument
         boresight.
   
   The EUROPAM UVS radiator frame -- EUROPAM_UVS_RAD -- is defined as
   follows:

      -  (TBD); rotated from the UVS mechanical frame by -90 degrees
         about +Z to make its +Z axis point along spacecraft -X.

   These diagrams illustrate the UVS frames:

      +Xsc view
      ---------
                                      ^
                         Velocity @CA |
                                      |
                                             +Xrad
                                                   ^
                                                   |     +Zsp
                              .           .-.    ..|   .>
                              | .-.       | | .-'|/| .'    +Xmech
                     .--.     |--------------'  ||=*-----> +Zap
                     `--.`-.  |               .-|| |`.     +Yrad 
                      -- `. `-|               | || |  `.   
                     .| \  `. |       ..      `    |    v  
              HGA   / |  \   `|       ||      +Yap v     +Ysp
                   /  |   \   |       ||    +Ymech     |
                  /   |    \  `-------||---           -'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            Nadir @CA
                 \    |     /   |     o     |    ||              ----->
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `' 
                                |     ||    |    
                            .===|     ||    |    
                           //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--'
              ..--''         `------- o--------->  
        ..--''                    +Xsc |    +Ysc   
     -''                               |           
                                      .|           
                                      ||           
                                      `'
                                                 +Xsc, +Xap, and +Xsp 
                                                  are out of the page

                                                   +Zmech and +Zrad 
                                                   are into the page

      +Ysc view
      ---------
                                      ^
                                      | Velocity @CA
                                      |
 
                                           +Xrad ^
                                                 |
                                            +Zsp ^      +Zrad
                                                 |      +Zmech
                              .----        <-----o----->
                              |        +Xap     ||      
                              |        +Xsp     |V +Ysp
                                             |  ||
                             '       `  |   |   |v +Ymech
         ------------.       |-------|  |   |   |  +Yap -----------
                 .    |      |       |  |   |   |          .
                 .    `      |       |  |   |   |     '    .
                 .     |     |       |   ----.--     |     .
                 .     `     `-------'       |       '     .
                 .      |      |             |      |      .
                 .      `      |             |      '      .
                 .       |     |             |     |       .
                 .       `     |             |     '       .
                 .        |    |             |    |        .
                 .        `  .-----------------.  '        .
                 .         | |                 | |         .
         +X SA   .         o=|                 |=o         .  -X SA
                 .         | |                 | |         .
                 .        .  |                 |  .        .
                 .        |  |                 |  |        .
                 .       .   |                 |   .       .
                 .       |   |                 |   |       .
                 .      .    |         +Zsc    |    .      .
                 .      |    `------- ^ -------'    |      .
                 .     .        |     |     |        .     .
                 .     |        |     |     |        |     .
                 .    .         |     |     |         .    .
                 .    |      .------- | -------.      |    .
         ------------'       |        |        |      `-------------
                            <---------o  ------'
                          +Xsc         +Ysc   

                                                        Nadir @CA, +Ysc,
                                                   +Xmech, +Zap, and +Yrad
                                                      are out of the page

                                                   +Zsp is out of the page,
                                               40 degrees off tyhe page normal.

                                                   +Ysp is out of the page,
                                                50 degrees off the page normal.

   The UVS frames are defined below as fixed offset frames.
    
   \begindata

      FRAME_EUROPAM_UVS_MECH           = -159302
      FRAME_-159302_NAME               = 'EUROPAM_UVS_MECH'
      FRAME_-159302_CLASS              = 4
      FRAME_-159302_CLASS_ID           = -159302
      FRAME_-159302_CENTER             = -159
      TKFRAME_-159302_SPEC             = 'ANGLES'
      TKFRAME_-159302_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159302_ANGLES           = ( -90.0, 90.0, 0.0 )
      TKFRAME_-159302_AXES             = ( 3, 1, 2 )
      TKFRAME_-159302_UNITS            = 'DEGREES'

      FRAME_EUROPAM_UVS_AP             = -159300
      FRAME_-159300_NAME               = 'EUROPAM_UVS_AP'
      FRAME_-159300_CLASS              = 4
      FRAME_-159300_CLASS_ID           = -159300
      FRAME_-159300_CENTER             = -159
      TKFRAME_-159300_SPEC             = 'ANGLES'
      TKFRAME_-159300_RELATIVE         = 'EUROPAM_UVS_MECH'
      TKFRAME_-159300_ANGLES           = ( 0.0, 0.0, -90.0 )
      TKFRAME_-159300_AXES             = ( 3, 1, 2 )
      TKFRAME_-159300_UNITS            = 'DEGREES'

      FRAME_EUROPAM_UVS_SP             = -159301
      FRAME_-159301_NAME               = 'EUROPAM_UVS_SP'
      FRAME_-159301_CLASS              = 4
      FRAME_-159301_CLASS_ID           = -159301
      FRAME_-159301_CENTER             = -159
      TKFRAME_-159301_SPEC             = 'ANGLES'
      TKFRAME_-159301_RELATIVE         = 'EUROPAM_UVS_AP'
      TKFRAME_-159301_ANGLES           = ( 0.0, -40.0, 0.0 )
      TKFRAME_-159301_AXES             = ( 3, 1, 2 )
      TKFRAME_-159301_UNITS            = 'DEGREES'

      FRAME_EUROPAM_UVS_RAD            = -159310
      FRAME_-159310_NAME               = 'EUROPAM_UVS_RAD'
      FRAME_-159310_CLASS              = 4
      FRAME_-159310_CLASS_ID           = -159310
      FRAME_-159310_CENTER             = -159
      TKFRAME_-159310_SPEC             = 'ANGLES'
      TKFRAME_-159310_RELATIVE         = 'EUROPAM_UVS_MECH'
      TKFRAME_-159310_ANGLES           = ( 90.0, 0.0, 0.0 )
      TKFRAME_-159310_AXES             = ( 3, 1, 2 )
      TKFRAME_-159310_UNITS            = 'DEGREES'

   \begintext
    

EUROPAM Magnetometer (ECM) Frames
========================================================================

   This section of the file contains the definitions ECM frames.


ECM Frame Tree
--------------

   The diagram below shows the frame hierarchy of the EUROPAM ECM
   frames.

                               "J2000" INERTIAL
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |                               
                                      |<-ck
                                      |                               
                                      V                               
                            "EUROPAM_SPACECRAFT"                      
                            --------------------
                                      |             
                                      |<-fixed      
                                      |               
                                      V              
                             "EUROPAM_ECM_MECH"   
                +------------------------------------------+
                |                     |                    |
                |<-fixed              |<-fixed             |<-fixed 
                |                     |                    |
                V                     V                    V
      "EUROPAM_ECM_FG1_MECH" "EUROPAM_ECM_FG2_MECH" "EUROPAM_ECM_FG3_MECH"
      ---------------------- ---------------------- ----------------------
                |                     |                    |
                |<-fixed              |<-fixed             |<-fixed 
                |                     |                    |
                V                     V                    V
        "EUROPAM_ECM_FG1"      "EUROPAM_ECM_FG2"     "EUROPAM_ECM_FG3"
        -----------------      -----------------     -----------------

ECM Frames
----------
    
   The EUROPAM ECM frame chains include seven frames -- EUROPAM_ECM_MECH, 
   EUROPAM_ECM_FG[1|2|3]_MECH, and EUROPAM_ECM_FG[1|2|3].

   The ECM boom mechanical frame -- EUROPAM_ECM_MECH -- is defined as 
   follows:

      -  +Y axis is aligned with the long axis of the magnetometer
         boom, pointing away from the spacecraft;
 
      -  +X axis is nominally co-aligned with the spacecraft -X axis;
 
      -  +Z axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the boom
         mounting plate;
 
      -  this frame is defined as a fixed offset frame with respect to
         the spacecraft frame.

   The ECM FG sensor mechanical frames -- EUROPAM_ECM_FG[1|2|3]_MECH 
   -- are defined as follows:

      -  +X axis is co-aligned with the boom mechanical frame +X axis;
 
      -  +Y axis is co-aligned with the boom mechanical frame +Z axis;
 
      -  +Z axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the sensor
         mounting plate;
 
      -  these frames are defined as fixed offset frames with respect
         to the boom mechanical frame.
 
      -  FG1, FG2, and FG3 mech frames are nominally co-aligned.

   The ECM FG sensor measurement frames -- EUROPAM_ECM_FG[1|2|3] 
   -- are defined to be co-aligned with their corresponding ECM FG 
   sensor mechanical frames.

   This diagram illustrates the ECM frames:

      +Xsc view
      ---------
                                      ^
                         Velocity @CA |
                                      |

                              .           .-.    ..     
                              | .-.       | | .-'|/  
                     .--.     |--------------'  ||== 
                     `--.`-.  |               .-||= 
                      -- `. `-|               | ||  
                     .| \  `. |       ..      `-|||
              HGA   / |  \   `|       ||        |||----.
                   /  |   \   |       ||      .-|||    | 
                  /   |    \  `-------||-----'  |||----'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            Nadir @CA
                 \    |     /   |     o     |    ||              ----->
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --              |     |    ||
                          +Zmech       +Zsc |.''.||
                              ^       ^     |    `' 
              +Y               \      ||    |    
        +Y     ^            .==.x     ||    |    
  +Y     ^  +Z  \  .>      / <'       ||    |                  
   ^      \  .>  x' +Z    / +Ymech -- ||-------.====================== 
    \  .>  x' +Z    ..--''            |.       |--'
     x' +Z    ..--''  ^      `------- o--------->  
        ..--''        | 20 deg    +Xsc |    +Ysc   
     -''              v                |           
                     ---              .|           
     ^     ^     ^                    ||           
     |     |     |                    `'
    FG1  FG2   FG3                               +Xsc is out of the page

                                             +Xmech, +Xfg1, +Xfg2, and +Xfg3
                                                   are into the page.

   The ECM frames are defined below as fixed offset frames.

   \begindata

      FRAME_EUROPAM_ECM_MECH           = -159400
      FRAME_-159400_NAME               = 'EUROPAM_ECM_MECH'
      FRAME_-159400_CLASS              = 4
      FRAME_-159400_CLASS_ID           = -159400
      FRAME_-159400_CENTER             = -159
      TKFRAME_-159400_SPEC             = 'ANGLES'
      TKFRAME_-159400_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159400_ANGLES           = ( 180.0, 20.0, 0.0 )
      TKFRAME_-159400_AXES             = ( 3, 1, 2 )
      TKFRAME_-159400_UNITS            = 'DEGREES'

      FRAME_EUROPAM_ECM_FG1_MECH       = -159401
      FRAME_-159401_NAME               = 'EUROPAM_ECM_FG1_MECH'
      FRAME_-159401_CLASS              = 4
      FRAME_-159401_CLASS_ID           = -159401
      FRAME_-159401_CENTER             = -159
      TKFRAME_-159401_SPEC             = 'ANGLES'
      TKFRAME_-159401_RELATIVE         = 'EUROPAM_ECM_MECH'
      TKFRAME_-159401_ANGLES           = ( 0.0, -90.0, 0.0 )
      TKFRAME_-159401_AXES             = ( 3, 1, 2 )
      TKFRAME_-159401_UNITS            = 'DEGREES'

      FRAME_EUROPAM_ECM_FG1            = -159402
      FRAME_-159402_NAME               = 'EUROPAM_ECM_FG1'
      FRAME_-159402_CLASS              = 4
      FRAME_-159402_CLASS_ID           = -159402
      FRAME_-159402_CENTER             = -159
      TKFRAME_-159402_SPEC             = 'ANGLES'
      TKFRAME_-159402_RELATIVE         = 'EUROPAM_ECM_FG1_MECH'
      TKFRAME_-159402_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159402_AXES             = ( 3, 1, 2 )
      TKFRAME_-159402_UNITS            = 'DEGREES'

      FRAME_EUROPAM_ECM_FG2_MECH       = -159403
      FRAME_-159403_NAME               = 'EUROPAM_ECM_FG2_MECH'
      FRAME_-159403_CLASS              = 4
      FRAME_-159403_CLASS_ID           = -159403
      FRAME_-159403_CENTER             = -159
      TKFRAME_-159403_SPEC             = 'ANGLES'
      TKFRAME_-159403_RELATIVE         = 'EUROPAM_ECM_MECH'
      TKFRAME_-159403_ANGLES           = ( 0.0, -90.0, 0.0 )
      TKFRAME_-159403_AXES             = ( 3, 1, 2 )
      TKFRAME_-159403_UNITS            = 'DEGREES'

      FRAME_EUROPAM_ECM_FG2            = -159404
      FRAME_-159404_NAME               = 'EUROPAM_ECM_FG2'
      FRAME_-159404_CLASS              = 4
      FRAME_-159404_CLASS_ID           = -159404
      FRAME_-159404_CENTER             = -159
      TKFRAME_-159404_SPEC             = 'ANGLES'
      TKFRAME_-159404_RELATIVE         = 'EUROPAM_ECM_FG2_MECH'
      TKFRAME_-159404_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159404_AXES             = ( 3, 1, 2 )
      TKFRAME_-159404_UNITS            = 'DEGREES'

      FRAME_EUROPAM_ECM_FG3_MECH       = -159405
      FRAME_-159405_NAME               = 'EUROPAM_ECM_FG3_MECH'
      FRAME_-159405_CLASS              = 4
      FRAME_-159405_CLASS_ID           = -159405
      FRAME_-159405_CENTER             = -159
      TKFRAME_-159405_SPEC             = 'ANGLES'
      TKFRAME_-159405_RELATIVE         = 'EUROPAM_ECM_MECH'
      TKFRAME_-159405_ANGLES           = ( 0.0, -90.0, 0.0 )
      TKFRAME_-159405_AXES             = ( 3, 1, 2 )
      TKFRAME_-159405_UNITS            = 'DEGREES'

      FRAME_EUROPAM_ECM_FG3            = -159406
      FRAME_-159406_NAME               = 'EUROPAM_ECM_FG3'
      FRAME_-159406_CLASS              = 4
      FRAME_-159406_CLASS_ID           = -159406
      FRAME_-159406_CENTER             = -159
      TKFRAME_-159406_SPEC             = 'ANGLES'
      TKFRAME_-159406_RELATIVE         = 'EUROPAM_ECM_FG3_MECH'
      TKFRAME_-159406_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159406_AXES             = ( 3, 1, 2 )
      TKFRAME_-159406_UNITS            = 'DEGREES'

   \begintext


EUROPAM MAss SPectrometer for Planetary EXploration (MASPEX) Frames
========================================================================

   This section of the file contains the definitions of the MASPEX 
   frames.
    

MASPEX Frame Tree
-----------------

   The diagram below shows the frame hierarchy of the EUROPAM MASPEX
   frames.

                               "J2000" INERTIAL
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |                               
                                      |<-ck
                                      |                               
                                      V                               
                            "EUROPAM_SPACECRAFT"                      
                            --------------------
                                      |             
                                      |<-fixed      
                                      |               
                                      V              
                            "EUROPAM_MASPEX_MECH"   
                            --------------------
                                      |                            
                                      |<-fixed                     
                                      |                            
                                      V                            
                               "EUROPAM_MASPEX"                   
                               ----------------         

                                
MASPEX Frames
-------------
    
   The EUROPAM MASPEX frame chains include two frames --
   EUROPAM_MASPEX_MECH, EUROPAM_MASPEX

   The MASPEX mechanical frame -- EUROPAM_MASPEX_MECH -- is defined as
   follows:

      -  +Z axis is along the axis of the drift tube, pointing towards
         the inlet, and is nominally co-aligned with the spacecraft +Z
         axis;
 
      -  +Y axis is normal to the mounting plate, pointing from the
         plate towards instrument assembly, and is nominally co-aligned
         with the spacecraft -X axis;
 
      -  +X axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the inlet
         ring;
 
      -  this frame is defined as a fixed offset frame with respect to
         the spacecraft frame.
 
   The MASPEX measurement frame -- EUROPAM_MASPEX -- is defined to be
   co-aligned with the MASPEX mechanical frame.
 
   This diagram illustrates the MASPEX frames:

      +Ysc view
      ---------
                                      ^
                                      | Velocity @CA
                                      |

                                              +Zmech
                                              +Zmaspex
                                             ^
                                             |
                                             |
                                             |
                              .------------- o----->
                              |        .-----.      +Ymaspex
                              |        |     |  |   +Ymech
                                       |     |  |
                             '       `  |   |   |
         ------------.       |-------|  |   |   |      .------------
                 .    |      |       |  |   |   |     |    .
                 .    `      |       |  |   |   |     '    .
                 .     |     |       |   ----.--     |     .
                 .     `     `-------'       |       '     .
                 .      |      |             |      |      .
                 .      `      |             |      '      .
                 .       |     |             |     |       .
                 .       `     |             |     '       .
                 .        |    |             |    |        .
                 .        `  .-----------------.  '        .
                 .         | |                 | |         .
         +X SA   .         o=|                 |=o         .  -X SA
                 .         | |                 | |         .
                 .        .  |                 |  .        .
                 .        |  |                 |  |        .
                 .       .   |                 |   .       .
                 .       |   |                 |   |       .
                 .      .    |         +Zsc    |    .      .
                 .      |    `------- ^ -------'    |      .
                 .     .        |     |     |        .     .
                 .     |        |     |     |        |     .
                 .    .         |     |     |         .    .
                 .    |      .------- | -------.      |    .
         ------------'       |        |        |      `-------------
                            <---------o  ------'
                          +Xsc         +Ysc   

                                                 +Ysc, +Xmaspex and Nadir @CA
                                                      are out of the page

   The MASPEX frames are defined below as fixed offset frames.
    
   \begindata

      FRAME_EUROPAM_MASPEX_MECH        = -159502
      FRAME_-159502_NAME               = 'EUROPAM_MASPEX_MECH'
      FRAME_-159502_CLASS              = 4
      FRAME_-159502_CLASS_ID           = -159502
      FRAME_-159502_CENTER             = -159
      TKFRAME_-159502_SPEC             = 'ANGLES'
      TKFRAME_-159502_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159502_ANGLES           = ( -90.0, 0.0, 0.0 )
      TKFRAME_-159502_AXES             = ( 3, 1, 2 )
      TKFRAME_-159502_UNITS            = 'DEGREES'

      FRAME_EUROPAM_MASPEX             = -159500
      FRAME_-159500_NAME               = 'EUROPAM_MASPEX'
      FRAME_-159500_CLASS              = 4
      FRAME_-159500_CLASS_ID           = -159500
      FRAME_-159500_CENTER             = -159
      TKFRAME_-159500_SPEC             = 'ANGLES'
      TKFRAME_-159500_RELATIVE         = 'EUROPAM_MASPEX_MECH'
      TKFRAME_-159500_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159500_AXES             = ( 3, 1, 2 )
      TKFRAME_-159500_UNITS            = 'DEGREES'
      
   \begintext
    


EUROPAM Mapping Imaging Spectrometer for Europa (MISE) Frames
========================================================================

   This section of the file contains the definitions of the MISE
   frames.
    

MISE Frame Tree
---------------

   The diagram below shows the frame hierarchy of the EUROPAM MISE
   frames.

                               "J2000" INERTIAL
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |                               
                                      |<-ck
                                      |                               
                                      V                               
                            "EUROPAM_SPACECRAFT"                      
                            --------------------
                                      |             
                                      |<-fixed      
                                      |               
                                      V              
                            "EUROPAM_MISE_MECH"   
                 +-----------------------------------------+
                 |                    |                    |
                 |<-fixed             |<-fixed             |<-fixed
                 |                    |                    |
                 V                    V                    V
        "EUROPAM_MISE_RAD1"   "EUROPAM_MISE_BASE"    "EUROPAM_MISE_RAD2"     
        ----------------      -------------------    ------------------- 
                                      |
                                      |<-ck
                                      |
                                      V
                                 "EUROPAM_MISE"
                                 --------------


MISE Frames
-----------

   The EUROPAM MISE frame chains include five frames --
   EUROPAM_MISE_MECH, EUROPAM_MISE_BASE, EUROPAM_MISE, EUROPAM_MISE_RAD1, and
   EUROPAM_MISE_RAD2.

   The MISE mechanical frame -- EUROPAM_MISE_MECH -- is defined to be
   nominally co-aligned with the spacecraft frame and is defined as a 
   fixed offset frame with respect to it.
 
   The MISE base frame -- EUROPAM_MISE_BASE -- is defined as follows:

      -  +Z axis is along the instrument boresight when the mirror is
         in the middle position;
 
      -  +X axis is along the scan mirror rotation axis and is
         nominally co-aligned with the mechanical frame's +X axis;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the intersection of the
         boresight and the scan mirror axis;
 
      -  this frame is defined as a fixed offset frame with respect to
         the MISE mechanical frame.
 
   The MISE measurement frame -- EUROPAM_MISE -- is defined as follows:

      -  +Z axis is along the instrument boresight at the current mirror
         position;
 
      -  +X axis is along the scan mirror rotation axis and is
         nominally co-aligned with the base frame +X axis;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the intersection of the
         boresight and the scan mirror axis;
 
      -  this frame rotates about +X with respect to the base frame
         and is defined as a CK-based frame.

      -  NOTE: this definition is different from the definition of the
         MISE optical reference frame (MISE_opt) provided in [4], which
         has the +Y axis, not +Z, aligned with the boresight.
 
   The MISE radiator frames -- EUROPAM_MISE_RAD1 and EUROPAM_MISE_RAD2
   -- are defined as follows:

      -  +Z axis is co-aligned with the normal to the radiator outer
         surface;
 
      -  +X axis is co-aligned with the MISE mechanical frame's +X
         axis.
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the
         radiator outer plate;
 
      -  both frames are defined as fixed offset frames with respect to
         the mechanical frame.
 
   This diagram illustrates the MISE frames:

      +Ysc view
      ---------

                                      ^
                           +Zmech     | Velocity @CA
                                      |
                     +Xrad*      ^
                     +Xmise   .- | -------------.
                     +Xbase   |  |     .-----.  | Instrument 
                     +Xmech      |     |     |  |    Deck
                           <-----o     |     |  |
                                 |   `  |   |   |
         ------------.       |---|---|  |   |   |      .------------
                 .    |          |   |  |   |   |     |    .
                 .    `   +Ybase v   |  |   |   |     '    .
                 .     |  +Ymise     |   ----.--     |     .
                 .     `  +Yrad*  ---'       |       '     .
                 .      |                    |      |      .
                 .      `      |             |      '      .
                 .       |     |             |     |       .
                 .       `     |             |     '       .
                 .        |    |             |    |        .
                 .        `  .-----------------.  '        .
                 .         | |                 | |         .
         +X SA   .         o=|                 |=o         .  -X SA
                 .         | |                 | |         .
                 .        .  |                 |  .        .
                 .        |  |                 |  |        .
                 .       .   |                 |   .       .
                 .       |   |                 |   |       .
                 .      .    |         +Zsc    |    .      .
                 .      |    `------- ^ -------'    |      .
                 .     .        |     |     |        .     .
                 .     |        |     |     |        |     .
                 .    .         |     |     |         .    .
                 .    |      .------- | -------.      |    .
         ------------'       |        |        |      `-------------
                            <---------o  ------'
                          +Xsc         +Ysc   
                                                 +Ysc, +Ymech, +Zbase, +Zmise,
                                                      +Zrad* and Nadir @CA
                                                      are out of the page


   The MISE frames are defined below.

   \begindata

      FRAME_EUROPAM_MISE_MECH          = -159602
      FRAME_-159602_NAME               = 'EUROPAM_MISE_MECH'
      FRAME_-159602_CLASS              = 4
      FRAME_-159602_CLASS_ID           = -159602
      FRAME_-159602_CENTER             = -159
      TKFRAME_-159602_SPEC             = 'ANGLES'
      TKFRAME_-159602_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159602_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159602_AXES             = ( 3, 1, 2 )
      TKFRAME_-159602_UNITS            = 'DEGREES'

      FRAME_EUROPAM_MISE_BASE          = -159600
      FRAME_-159600_NAME               = 'EUROPAM_MISE_BASE'
      FRAME_-159600_CLASS              = 4
      FRAME_-159600_CLASS_ID           = -159600
      FRAME_-159600_CENTER             = -159
      TKFRAME_-159600_SPEC             = 'ANGLES'
      TKFRAME_-159600_RELATIVE         = 'EUROPAM_MISE_MECH'
      TKFRAME_-159600_ANGLES           = ( 0.0, 90.0, 0.0 )
      TKFRAME_-159600_AXES             = ( 3, 1, 2 )
      TKFRAME_-159600_UNITS            = 'DEGREES'

      FRAME_EUROPAM_MISE               = -159601
      FRAME_-159601_NAME               = 'EUROPAM_MISE'
      FRAME_-159601_CLASS              = 3
      FRAME_-159601_CLASS_ID           = -159601
      FRAME_-159601_CENTER             = -159
      CK_-159601_SCLK                  = -159
      CK_-159601_SPK                   = -159

      FRAME_EUROPAM_MISE_RAD1          = -159610
      FRAME_-159610_NAME               = 'EUROPAM_MISE_RAD1'
      FRAME_-159610_CLASS              = 4
      FRAME_-159610_CLASS_ID           = -159610
      FRAME_-159610_CENTER             = -159
      TKFRAME_-159610_SPEC             = 'ANGLES'
      TKFRAME_-159610_RELATIVE         = 'EUROPAM_MISE_MECH'
      TKFRAME_-159610_ANGLES           = ( 0.0, 90.0, 0.0 )
      TKFRAME_-159610_AXES             = ( 3, 1, 2 )
      TKFRAME_-159610_UNITS            = 'DEGREES'

      FRAME_EUROPAM_MISE_RAD2          = -159611
      FRAME_-159611_NAME               = 'EUROPAM_MISE_RAD2'
      FRAME_-159611_CLASS              = 4
      FRAME_-159611_CLASS_ID           = -159611
      FRAME_-159611_CENTER             = -159
      TKFRAME_-159611_SPEC             = 'ANGLES'
      TKFRAME_-159611_RELATIVE         = 'EUROPAM_MISE_MECH'
      TKFRAME_-159611_ANGLES           = ( 0.0, 90.0, 0.0 )
      TKFRAME_-159611_AXES             = ( 3, 1, 2 )
      TKFRAME_-159611_UNITS            = 'DEGREES'
        
   \begintext
                                                           

EUROPAM Plasma Instrument for Magnetic Sounding (PIMS) Frames
========================================================================

   This section of the file contains the definitions of the PIMS
   frames.


PIMS Frame Tree
---------------

   The diagram below shows the frame hierarchy of the EUROPAM PIMS
   frames.

                               "J2000" INERTIAL
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |                               
                                      |<-ck
                                      |                               
                                      V                               
                            "EUROPAM_SPACECRAFT"                      
                    +-----------------------------------+
                    |                                   |
                    |<-fixed                            |<-fixed
                    |                                   |
                    V                                   V
        "EUROPAM_PIMS_UPPER_MECH"           "EUROPAM_PIMS_LOWER_MECH"     
        -------------------------           ------------------------- 
                    |                                   |
                    |<-fixed                            |<-fixed
                    |                                   |
                    V                                   V
           "EUROPAM_PIMS_UPPER"               "EUROPAM_PIMS_LOWER"     
           +------------------+               +------------------+
           |                  |               |                  |
           |<-fixed           |               |<-fixed           |
           |                  |               |                  |
           V                  |               V                  |
   "EUROPAM_PIMS_RAM"         |    "EUROPAM_PIMS_ANTI_RAM"       |     
   ------------------         |    -----------------------       |
                              |                                  |
                              |<-fixed                           |<-fixed 
                              |                                  |
                              V                                  V
             "EUROPAM_PIMS_ANTI_NADIR"             "EUROPAM_PIMS_NADIR"
             -------------------------             --------------------


PIMS Frames
-----------

   The EUROPAM PIMS frame chains include eight frames --
   EUROPAM_PIMS_[UPPER|LOWER]_MECH, EUROPAM_PIMS_[UPPER|LOWER],
   EUROPAM_PIMS_RAM, EUROPAM_PIMS_ANTI_RAM, EUROPAM_PIMS_NADIR, and
   EUROPAM_PIMS_ANTI_NADIR.

   The PIMS UPPER head mechanical frame -- EUROPAM_PIMS_UPPER_MECH --
   is defined to be nominally rotated by 180 degrees about +Z with
   respect to the spacecraft frame.
 
   The PIMS UPPER head frame -- EUROPAM_PIMS_UPPER -- is defined to be
   co-aligned with the PIMS UPPER mechanical frame.
 
   The PIMS LOWER head mechanical frame -- EUROPAM_PIMS_LOWER_MECH --
   is defined to be nominally rotated by 180 degrees about +Y with
   respect to the spacecraft frame.
 
   The PIMS LOWER head frame -- EUROPAM_PIMS_LOWER -- is defined to be
   co-aligned with the PIMS LOWER mechanical frame.
 
   The PIMS detector frames -- EUROPAM_PIMS_RAM, EUROPAM_PIMS_ANTI_RAM,
   EUROPAM_PIMS_NADIR, and EUROPAM_PIMS_ANTI_NADIR -- are defined as
   follows:

      -  +Z axis is along the detector boresight;
 
      -  +X axis is co-aligned with the corresponding head's +X axis;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the
         detector's outer rim;
 
      -  the detector frames are defined as fixed offset frames with
         respect to the corresponding head frame
 
   This diagram illustrates the PIMS frames:

      +Xsc view
      ---------
                                      ^
                       +Zram          | Velocity @CA
                       +Zupper        |
                     ^ +Zumech
                     |                    
                     |        .           .-.    ..     
                     |        | .-.       | | .-'|/  
               <-----x--.     |--------------'  ||==   
         +Yumech     | -.`-.  |               .-||= 
         +Yupper     | - `. `-|               | ||   
         +Yram       |  \  `. |       ..      `-|||
         +Za-nadir   v       `        ||        |||----.
                      +Ya-nadir       ||      .-|||    | 
                  /            -------||-----'  |||----'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            Nadir @CA
                 \    |     /   |     o     |    ||              ----->
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||  
              HGA   \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |       +Ynadir
                                |     ||    |     ^
                            .===|     ||    |     |
                           //   |     ||    |     |            
     ==================== //=.------- ||-------.==|=================== 
                    ..--''   |        |.       |--x-----> +Ylmech
              ..--''         `------- o---------> |       +Ylower
        ..--''                    +Xsc |    +Ysc  |       +Ya-ram
     -''                               |          |       +Znadir
                                      .|          v 
                                      ||            +Zlmech
                                      `'            +Zlower
                                                    +Za-ram


                                                +Xsc is out of the page

                                            All PIMS +Xs are into the page

   The PIMS frames are defined below as fixed offset frames.
    
   \begindata

      FRAME_EUROPAM_PIMS_UPPER_MECH    = -159704
      FRAME_-159704_NAME               = 'EUROPAM_PIMS_UPPER_MECH'
      FRAME_-159704_CLASS              = 4
      FRAME_-159704_CLASS_ID           = -159704
      FRAME_-159704_CENTER             = -159
      TKFRAME_-159704_SPEC             = 'ANGLES'
      TKFRAME_-159704_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159704_ANGLES           = ( 180.0, 0.0, 0.0 )
      TKFRAME_-159704_AXES             = ( 3, 1, 2 )
      TKFRAME_-159704_UNITS            = 'DEGREES'

      FRAME_EUROPAM_PIMS_UPPER         = -159705
      FRAME_-159705_NAME               = 'EUROPAM_PIMS_UPPER'
      FRAME_-159705_CLASS              = 4
      FRAME_-159705_CLASS_ID           = -159705
      FRAME_-159705_CENTER             = -159
      TKFRAME_-159705_SPEC             = 'ANGLES'
      TKFRAME_-159705_RELATIVE         = 'EUROPAM_PIMS_UPPER_MECH'
      TKFRAME_-159705_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159705_AXES             = ( 3, 1, 2 )
      TKFRAME_-159705_UNITS            = 'DEGREES'

      FRAME_EUROPAM_PIMS_RAM           = -159700
      FRAME_-159700_NAME               = 'EUROPAM_PIMS_RAM'
      FRAME_-159700_CLASS              = 4
      FRAME_-159700_CLASS_ID           = -159700
      FRAME_-159700_CENTER             = -159
      TKFRAME_-159700_SPEC             = 'ANGLES'
      TKFRAME_-159700_RELATIVE         = 'EUROPAM_PIMS_UPPER'
      TKFRAME_-159700_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159700_AXES             = ( 3, 1, 2 )
      TKFRAME_-159700_UNITS            = 'DEGREES'

      FRAME_EUROPAM_PIMS_ANTI_NADIR    = -159703
      FRAME_-159703_NAME               = 'EUROPAM_PIMS_ANTI_NADIR'
      FRAME_-159703_CLASS              = 4
      FRAME_-159703_CLASS_ID           = -159703
      FRAME_-159703_CENTER             = -159
      TKFRAME_-159703_SPEC             = 'ANGLES'
      TKFRAME_-159703_RELATIVE         = 'EUROPAM_PIMS_UPPER'
      TKFRAME_-159703_ANGLES           = ( 0.0, 90.0, 0.0 )
      TKFRAME_-159703_AXES             = ( 3, 1, 2 )
      TKFRAME_-159703_UNITS            = 'DEGREES'

      FRAME_EUROPAM_PIMS_LOWER_MECH    = -159706
      FRAME_-159706_NAME               = 'EUROPAM_PIMS_LOWER_MECH'
      FRAME_-159706_CLASS              = 4
      FRAME_-159706_CLASS_ID           = -159706
      FRAME_-159706_CENTER             = -159
      TKFRAME_-159706_SPEC             = 'ANGLES'
      TKFRAME_-159706_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159706_ANGLES           = ( 0.0, 0.0, 180.0 )
      TKFRAME_-159706_AXES             = ( 3, 1, 2 )
      TKFRAME_-159706_UNITS            = 'DEGREES'

      FRAME_EUROPAM_PIMS_LOWER         = -159707
      FRAME_-159707_NAME               = 'EUROPAM_PIMS_LOWER'
      FRAME_-159707_CLASS              = 4
      FRAME_-159707_CLASS_ID           = -159707
      FRAME_-159707_CENTER             = -159
      TKFRAME_-159707_SPEC             = 'ANGLES'
      TKFRAME_-159707_RELATIVE         = 'EUROPAM_PIMS_LOWER_MECH'
      TKFRAME_-159707_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159707_AXES             = ( 3, 1, 2 )
      TKFRAME_-159707_UNITS            = 'DEGREES'

      FRAME_EUROPAM_PIMS_ANTI_RAM      = -159701
      FRAME_-159701_NAME               = 'EUROPAM_PIMS_ANTI_RAM'
      FRAME_-159701_CLASS              = 4
      FRAME_-159701_CLASS_ID           = -159701
      FRAME_-159701_CENTER             = -159
      TKFRAME_-159701_SPEC             = 'ANGLES'
      TKFRAME_-159701_RELATIVE         = 'EUROPAM_PIMS_LOWER'
      TKFRAME_-159701_ANGLES           = ( 0.0, 0.0, 0.0 )
      TKFRAME_-159701_AXES             = ( 3, 1, 2 )
      TKFRAME_-159701_UNITS            = 'DEGREES'

      FRAME_EUROPAM_PIMS_NADIR         = -159702
      FRAME_-159702_NAME               = 'EUROPAM_PIMS_NADIR'
      FRAME_-159702_CLASS              = 4
      FRAME_-159702_CLASS_ID           = -159702
      FRAME_-159702_CENTER             = -159
      TKFRAME_-159702_SPEC             = 'ANGLES'
      TKFRAME_-159702_RELATIVE         = 'EUROPAM_PIMS_LOWER'
      TKFRAME_-159702_ANGLES           = ( 0.0, 90.0, 0.0 )
      TKFRAME_-159702_AXES             = ( 3, 1, 2 )
      TKFRAME_-159702_UNITS            = 'DEGREES'
      
   \begintext


EUROPAM Radar for Europa Assessment and Sounding: Ocean to Near-surface (REASON) Frames
========================================================================

   This section of the file contains the definitions of the REASON
   frames.


REASON Frame Tree
-----------------

   The diagram below shows the frame hierarchy of the EUROPAM REASON
   frames.

                               "J2000" INERTIAL
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |                               
                                      |<-ck
                                      |                               
                                      V                               
                            "EUROPAM_SPACECRAFT"                      
            +-----------------------------------
            |                         |
            |<-fixed                  |<-fixed
            |                         |
            V                         V
    "EUROPAM_REASON"          "EUROPAM_SA_BASE"
    ----------------       +---------------------+
                           |                     |
                           |<-ck                 |<-ck
                           |                     |
                           V                     V
                       "EUROPAM_SA+X"   "EUROPAM_SA-X"
                       --------------   --------------
                           |   |   |     |   |   |
                    fixed->|   |   |     |   |   |<-fixed
                           |   |   |     |   |   |
                           V   |   |     |   |   V
     "EUROPAM_REASON_VHF+X_O"  |   |     |   |  "EUROPAM_REASON_VHF-X_O"
     ------------------------  |   |     |   |  ------------------------
                               |   |     |   |  
                        fixed->|   |     |   |<-fixed 
                               |   |     |   |  
                               V   |     |   V  
            "EUROPAM_REASON_HF+X"  |     |  "EUROPAM_REASON_HF-X"
            ---------------------  |     |  ---------------------
                                   |     |  
                            fixed->|     |<-fixed  
                                   |     |  
                                   V     V  
             "EUROPAM_REASON_VHF+X_I"   "EUROPAM_REASON_VHF-X_I"
             ------------------------   ------------------------


REASON Frames
-------------

   The EUROPAM REASON frame chains include seven frames --
   EUROPAM_REASON, EUROPAM_REASON_VHF+X_I, EUROPAM_REASON_VHF+X_O,
   EUROPAM_REASON_VHF-X_I, EUROPAM_REASON_VHF-X_O, EUROPAM_REASON_HF+X,
   and EUROPAM_REASON_HF-X.
 
   The REASON ``planning'' frame -- EUROPAM_REASON -- is defined 
   as follows:

      -  +Z axis is along the s/c +Y axis, pointing nadir @ CA;
 
      -  +X axis is along the s/c +X axis;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the s/c frame origin;

      -  this frame is defined as a fixed offset frame with respect to
         the spacecraft frame and is nominally rotated by -90 degrees
         about +X with respect to it

   The REASON antenna frames -- EUROPAM_REASON_VHF+X_I,
   EUROPAM_REASON_VHF+X_O, EUROPAM_REASON_VHF-X_I,
   EUROPAM_REASON_VHF-X_O, EUROPAM_REASON_HF+X, and EUROPAM_REASON_HF-X
   -- are defined as follows:

      -  +Z axis is along the solar array normal on the active cell
         side and is nominally co-aligned with the corresponding solar
         array frame's +Z axis;
 
      -  +Y axis is along the solar array rotation axis and is
         nominally co-aligned with the corresponding solar array
         frame's +X axis;
 
      -  +X axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the
         antenna's mounting plate;
 
      -  these frames are defined as fixed offset frames relative to
         the corresponding solar array frames and are nominally rotated
         by -90 degrees about +Z with respect to them.

   This diagram illustrates the REASON frames:

      +Ysc view
      ---------
                                      ^
                                      | Velocity @CA
                                      |

                            +Ysa+x .-----. +Ysa-x
     .--------------------------. ^|-- --|^ .--------------------------.
     | .     .     .     .     . \||     ||  .     .     .     .     . |
     | .     .     .     .     .  ||     ||  .     .     .     .     . |
     | .     .     .     .+Xsa+x  |+Xsa-x||  .     .     .     .     . |
     | .     .     .     .  <-----* <-----*  .     .     .     .     . |
     | .     .     .     .     .  ||  ^+Zsc  .     .     .     .     . |
     | .     .     .     .     .  .|  |  |`  .     .     .     .     . |
     | .     .     .     .     . / |  |  | \ .     .     .     .     . |
   +Yvhfo  +Yhf ---- +Yvhfi ----'  /--| +Yvhfi ---- +Yhf -- +Yvhfo ----'
      <---x <---x       <---x   <-----o --' <---x       <---x <---x
          |     |           | +Xsc    |         |           |     |
          |     |           |         |         |           |     |
          v     v           v         |         v           v     v
      +Xvhfo  +Xhf        +Xvhfi      v      +Xvhfi       +Xhf +Xvhfo
                                  +Yreason

                                                    +Ysc and +Zreason 
                                                    are out of the page.

                                               +Zsa+/-x, +Zvhfi/o, and +Zhf, 
                                                     are into the page.

   All REASON frames are defined below as fixed offset frames.

   \begindata

      FRAME_EUROPAM_REASON             = -159800
      FRAME_-159800_NAME               = 'EUROPAM_REASON'
      FRAME_-159800_CLASS              = 4
      FRAME_-159800_CLASS_ID           = -159800
      FRAME_-159800_CENTER             = -159
      TKFRAME_-159800_SPEC             = 'ANGLES'
      TKFRAME_-159800_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159800_ANGLES           = ( 0.0, 90.0, 0.0 )
      TKFRAME_-159800_AXES             = ( 3, 1, 2 )
      TKFRAME_-159800_UNITS            = 'DEGREES'

      FRAME_EUROPAM_REASON_VHF+X_I     = -159801
      FRAME_-159801_NAME               = 'EUROPAM_REASON_VHF+X_I'
      FRAME_-159801_CLASS              = 4
      FRAME_-159801_CLASS_ID           = -159801
      FRAME_-159801_CENTER             = -159
      TKFRAME_-159801_SPEC             = 'ANGLES'
      TKFRAME_-159801_RELATIVE         = 'EUROPAM_SA+X'
      TKFRAME_-159801_ANGLES           = ( 90.0, 0.0, 0.0 )
      TKFRAME_-159801_AXES             = ( 3, 1, 2 )
      TKFRAME_-159801_UNITS            = 'DEGREES'

      FRAME_EUROPAM_REASON_VHF+X_O     = -159802
      FRAME_-159802_NAME               = 'EUROPAM_REASON_VHF+X_O'
      FRAME_-159802_CLASS              = 4
      FRAME_-159802_CLASS_ID           = -159802
      FRAME_-159802_CENTER             = -159
      TKFRAME_-159802_SPEC             = 'ANGLES'
      TKFRAME_-159802_RELATIVE         = 'EUROPAM_SA+X'
      TKFRAME_-159802_ANGLES           = ( 90.0, 0.0, 0.0 )
      TKFRAME_-159802_AXES             = ( 3, 1, 2 )
      TKFRAME_-159802_UNITS            = 'DEGREES'

      FRAME_EUROPAM_REASON_HF+X        = -159803
      FRAME_-159803_NAME               = 'EUROPAM_REASON_HF+X'
      FRAME_-159803_CLASS              = 4
      FRAME_-159803_CLASS_ID           = -159803
      FRAME_-159803_CENTER             = -159
      TKFRAME_-159803_SPEC             = 'ANGLES'
      TKFRAME_-159803_RELATIVE         = 'EUROPAM_SA+X'
      TKFRAME_-159803_ANGLES           = ( 90.0, 0.0, 0.0 )
      TKFRAME_-159803_AXES             = ( 3, 1, 2 )
      TKFRAME_-159803_UNITS            = 'DEGREES'

      FRAME_EUROPAM_REASON_VHF-X_I     = -159804
      FRAME_-159804_NAME               = 'EUROPAM_REASON_VHF-X_I'
      FRAME_-159804_CLASS              = 4
      FRAME_-159804_CLASS_ID           = -159804
      FRAME_-159804_CENTER             = -159
      TKFRAME_-159804_SPEC             = 'ANGLES'
      TKFRAME_-159804_RELATIVE         = 'EUROPAM_SA-X'
      TKFRAME_-159804_ANGLES           = ( 90.0, 0.0, 0.0 )
      TKFRAME_-159804_AXES             = ( 3, 1, 2 )
      TKFRAME_-159804_UNITS            = 'DEGREES'

      FRAME_EUROPAM_REASON_VHF-X_O     = -159805
      FRAME_-159805_NAME               = 'EUROPAM_REASON_VHF-X_O'
      FRAME_-159805_CLASS              = 4
      FRAME_-159805_CLASS_ID           = -159805
      FRAME_-159805_CENTER             = -159
      TKFRAME_-159805_SPEC             = 'ANGLES'
      TKFRAME_-159805_RELATIVE         = 'EUROPAM_SA-X'
      TKFRAME_-159805_ANGLES           = ( 90.0, 0.0, 0.0 )
      TKFRAME_-159805_AXES             = ( 3, 1, 2 )
      TKFRAME_-159805_UNITS            = 'DEGREES'

      FRAME_EUROPAM_REASON_HF-X        = -159806
      FRAME_-159806_NAME               = 'EUROPAM_REASON_HF-X'
      FRAME_-159806_CLASS              = 4
      FRAME_-159806_CLASS_ID           = -159806
      FRAME_-159806_CENTER             = -159
      TKFRAME_-159806_SPEC             = 'ANGLES'
      TKFRAME_-159806_RELATIVE         = 'EUROPAM_SA-X'
      TKFRAME_-159806_ANGLES           = ( 90.0, 0.0, 0.0 )
      TKFRAME_-159806_AXES             = ( 3, 1, 2 )
      TKFRAME_-159806_UNITS            = 'DEGREES'
      
   \begintext
  
  
EUROPAM SUrface Dust Mass Analyzer (SUDA) Frames
========================================================================

   This section of the file contains the definitions of the SUDA
   frames.


SUDA Frame Tree
---------------

   The diagram below shows the frame hierarchy of the EUROPAM REASON
   frames.

                               "J2000" INERTIAL
           +-----------------------------------------------------+
           |                |         |                          |
           |<-pck           |<-pck    |                          |<-pck
           |                |         |                          |
           V                V         |                          V
      "IAU_CALLISTO"  "IAU_EUROPA"    |                    "IAU_GANYMEDE"
      --------------   -----------    |                    --------------
                                      |                               
                                      |<-ck
                                      |                               
                                      V                               
                            "EUROPAM_SPACECRAFT"                      
                            --------------------
                                      |
                                      |<-fixed
                                      |
                                      V
                              "EUROPAM_SUDA"
                              --------------


SUDA Frames
-----------

   The EUROPAM REASON frame chain includes one frame -- EUROPAM_SUDA.

   The SUDA frame -- EUROPAM_SUDA -- is defined as follows:

      -  +Z axis is co-aligned with the instrument boresight;
 
      -  +X axis is along the s/c +Y axis;
 
      -  +Y axis is defined such that (X,Y,Z) is right handed;
 
      -  the origin of the frame is located at the center of the SUDA
         detector;

      -  this frame is defined as a fixed offset frame with respect to
         the spacecraft frame and is nominally rotated by +90 degrees
         about +Z with respect to it

   This diagram illustrates the SUDA frame:

                                      ^
                                      | Velocity @CA
                                      |
                           +Zsuda
                                 ^
                                 |
                                 |
                              .  |     +Xsuda     ..     
                              | .x----->      .-'|/  
                     .--.     |--------------'  ||==   
                     `--.`-.  |               .-||= 
                      -- `. `-|               | ||   
                     .| \  `. |       ..      `-|||
              HGA   / |  \   `|       ||        |||----.
                   /  |   \   |       ||      .-|||    | 
                  /   |    \  `-------||-----'  |||----'
                 /    |     \   |     ||    |   ||| 
                /     |      \  |     ||    |   `'
               /      |       `-|     ||    |    
              .       |       | |     ||    |    
              |       |       | |     ||    |    
              `       |       | |     ||    |    
               \`     |       .-|     ||    |    .. 
                \     |      /  |     ||    |`..'||            Nadir @CA
                 \    |     /   |     o     |    ||              ----->
                  \   |    /    |     ||    |    ||
                   \  |   /     |     ||    |    ||  
                    \ |  /      |     ||    |    ||
                     \| /       |     ||    |    ||
                      --        |     |     |    ||
                                |      +Zsc |.''.||
                                |     ^     |    `'
                                |     ||    |    
                            .===|     ||    |    
                           //   |     ||    |                  
     ==================== //=.------- ||-------.====================== 
                    ..--''   |        |.       |--'
              ..--''         `------- o--------->
        ..--''                    +Xsc |    +Ysc
     -''                               |
                                      .|
                                      ||
                                      `'

                                                +Xsc is out of the page
                                              +Ysuda is into of the page


   The SUDA frame is defined below as a fixed-offset frame.

   \begindata

      FRAME_EUROPAM_SUDA               = -159150
      FRAME_-159150_NAME               = 'EUROPAM_SUDA'
      FRAME_-159150_CLASS              = 4
      FRAME_-159150_CLASS_ID           = -159150
      FRAME_-159150_CENTER             = -159
      TKFRAME_-159150_SPEC             = 'ANGLES'
      TKFRAME_-159150_RELATIVE         = 'EUROPAM_SPACECRAFT'
      TKFRAME_-159150_ANGLES           = ( -90.0, 0.0, 0.0 )
      TKFRAME_-159150_AXES             = ( 3, 1, 2 )
      TKFRAME_-159150_UNITS            = 'DEGREES'
      
   \begintext
   
  
EUROPAM Mission NAIF Name-ID Mappings -- Definition Section
========================================================================

  
EUROPAM Spacecraft Name-ID Mappings
-----------------------------------

   This table summarizes EUROPAM Spacecraft name-ID mappings:

      Name                       ID       Synonyms
      -------------------------  -------  ---------------
      EUROPAM                    -159     EURC, EUROPA_CLIPPER

   Name-ID Mapping keywords:

   \begindata

      NAIF_BODY_NAME                  += ( 'EURC' )
      NAIF_BODY_CODE                  += ( -159 )

      NAIF_BODY_NAME                  += ( 'EUROPA_CLIPPER' )
      NAIF_BODY_CODE                  += ( -159 )

      NAIF_BODY_NAME                  += ( 'EUROPAM' )
      NAIF_BODY_CODE                  += ( -159 )

   \begintext


EUROPAM Spacecraft Structures Name-ID Mappings
----------------------------------------------

   This table summarizes EUROPAM Spacecraft Structure name-ID mappings:

      Name                       ID
      -------------------------  -------
      EUROPAM_SPACECRAFT         -159000
      EUROPAM_SA_BASE            -159010
      EUROPAM_SA+X               -159011
      EUROPAM_SA-X               -159012
      EUROPAM_DSS+Y              -159021
      EUROPAM_DSS-Y              -159022
      EUROPAM_DSS+Y_KOZ          -159023
      EUROPAM_DSS-Y_KOZ          -159024
      EUROPAM_ST1                -159030
      EUROPAM_ST2                -159031
      EUROPAM_ST1_KOZSUN         -159034
      EUROPAM_ST2_KOZSUN         -159035
      EUROPAM_ST1_KOZSUN_IC      -159036
      EUROPAM_ST2_KOZSUN_IC      -159037
      EUROPAM_ST1_KOZ            -159038
      EUROPAM_ST2_KOZ            -159039
      EUROPAM_LGA+Y              -159050
      EUROPAM_LGA-Y              -159051
      EUROPAM_LGA-Z              -159052
      EUROPAM_MGA                -159060
      EUROPAM_HGA                -159070
      EUROPAM_FBA-Y+Z            -159081
      EUROPAM_FBA1               -159081
      EUROPAM_FBA-Y-Z            -159082
      EUROPAM_FBA2               -159082
      EUROPAM_FBA+Y-Z            -159083
      EUROPAM_FBA3               -159083
      EUROPAM_RADIATOR           -159090
            
   Name-ID Mapping keywords:

   \begindata

      NAIF_BODY_NAME                  += ( 'EUROPAM_SPACECRAFT' )
      NAIF_BODY_CODE                  += ( -159000 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_SA_BASE' )
      NAIF_BODY_CODE                  += ( -159010 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_SA+X' )
      NAIF_BODY_CODE                  += ( -159011 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_SA-X' )
      NAIF_BODY_CODE                  += ( -159012 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_DSS+Y' )
      NAIF_BODY_CODE                  += ( -159021 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_DSS-Y' )
      NAIF_BODY_CODE                  += ( -159022 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_DSS+Y_KOZ' )
      NAIF_BODY_CODE                  += ( -159023 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_DSS-Y_KOZ' )
      NAIF_BODY_CODE                  += ( -159024 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ST1' )
      NAIF_BODY_CODE                  += ( -159030 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ST2' )
      NAIF_BODY_CODE                  += ( -159031 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ST1_KOZSUN' )
      NAIF_BODY_CODE                  += ( -159034 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ST2_KOZSUN' )
      NAIF_BODY_CODE                  += ( -159035 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ST1_KOZSUN_IC' )
      NAIF_BODY_CODE                  += ( -159036 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ST2_KOZSUN_IC' )
      NAIF_BODY_CODE                  += ( -159037 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ST1_KOZ' )
      NAIF_BODY_CODE                  += ( -159038 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ST2_KOZ' )
      NAIF_BODY_CODE                  += ( -159039 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_LGA+Y' )
      NAIF_BODY_CODE                  += ( -159050 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_LGA-Y' )
      NAIF_BODY_CODE                  += ( -159051 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_LGA-Z' )
      NAIF_BODY_CODE                  += ( -159052 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MGA' )
      NAIF_BODY_CODE                  += ( -159060 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_HGA' )
      NAIF_BODY_CODE                  += ( -159070 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_FBA-Y+Z' )
      NAIF_BODY_CODE                  += ( -159081 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_FBA1' )
      NAIF_BODY_CODE                  += ( -159081 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_FBA-Y-Z' )
      NAIF_BODY_CODE                  += ( -159082 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_FBA2' )
      NAIF_BODY_CODE                  += ( -159082 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_FBA+Y-Z' )
      NAIF_BODY_CODE                  += ( -159083 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_FBA3' )
      NAIF_BODY_CODE                  += ( -159083 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_RADIATOR' )
      NAIF_BODY_CODE                  += ( -159090 )

   \begintext


EUROPAM Instrument Name-ID Mappings
-----------------------------------
      
   This table summarizes EUROPAM Instrument name-ID mappings:

      Name                       ID
      -------------------------  -------
      EUROPAM_EIS_NAC_BASE       -159100

      EUROPAM_EIS_NAC            -159101

      EUROPAM_EIS_NAC_CLEAR      -159121
      EUROPAM_EIS_NAC_S_AFT      -159122
      EUROPAM_EIS_NAC_S_NADIR    -159123
      EUROPAM_EIS_NAC_S_FORE     -159124
      EUROPAM_EIS_NAC_NUV        -159125
      EUROPAM_EIS_NAC_BLU        -159126
      EUROPAM_EIS_NAC_GRN        -159127
      EUROPAM_EIS_NAC_RED        -159128
      EUROPAM_EIS_NAC_IR1        -159129
      EUROPAM_EIS_NAC_1MU        -159130
      EUROPAM_EIS_NAC_COLOR      -159131

      EUROPAM_EIS_WAC            -159102

      EUROPAM_EIS_WAC_CLEAR      -159141
      EUROPAM_EIS_WAC_S_AFT      -159142
      EUROPAM_EIS_WAC_S_NADIR    -159143
      EUROPAM_EIS_WAC_S_FORE     -159144
      EUROPAM_EIS_WAC_NUV        -159145
      EUROPAM_EIS_WAC_BLU        -159146
      EUROPAM_EIS_WAC_GRN        -159147
      EUROPAM_EIS_WAC_RED        -159148
      EUROPAM_EIS_WAC_IR1        -159149
      EUROPAM_EIS_WAC_1MU        -159150
      EUROPAM_EIS_WAC_COLOR      -159151

      EUROPAM_EIS_NAC_RAD        -159110
      EUROPAM_EIS_WAC_RAD        -159111

      EUROPAM_EIS_NAC_KOZ        -159112
      EUROPAM_EIS_WAC_KOZ        -159113

      EUROPAM_ETHEMIS            -159200
      EUROPAM_ETHEMIS_KOZ        -159201
      EUROPAM_ETHEMIS_RAD1       -159202
      EUROPAM_ETHEMIS_RAD2       -159203
      EUROPAM_ETHEMIS_BAND1      -159210
      EUROPAM_ETHEMIS_BAND2      -159220
      EUROPAM_ETHEMIS_BAND3      -159230

      EUROPAM_UVS_AP             -159300
      EUROPAM_UVS_SP             -159301
      EUROPAM_UVS_RAD            -159310
      EUROPAM_UVS_AP_KOZ_10      -159320
      EUROPAM_UVS_AP_KOZ_20      -159321
      EUROPAM_UVS_SP_KOZ         -159330

      EUROPAM_ECM                -159400
      EUROPAM_ECM_FG1            -159402
      EUROPAM_ECM_FG2            -159404
      EUROPAM_ECM_FG3            -159406

      EUROPAM_MASPEX             -159500
      EUROPAM_MASPEX_KOZ         -159502

      EUROPAM_MISE_BASE          -159600
      EUROPAM_MISE               -159601
      EUROPAM_MISE_FOR           -159602
      EUROPAM_MISE_GLOBAL        -159603
      EUROPAM_MISE_KOZ           -159604
      EUROPAM_MISE_RAD1+Y        -159610
      EUROPAM_MISE_RAD1+X        -159611
      EUROPAM_MISE_RAD2+Y        -159612
      EUROPAM_MISE_RAD2+X        -159613

      EUROPAM_PIMS_RAM           -159700
      EUROPAM_PIMS_ANTI_RAM      -159701
      EUROPAM_PIMS_NADIR         -159702
      EUROPAM_PIMS_ANTI_NADIR    -159703

      EUROPAM_REASON             -159800
      EUROPAM_REASON_VHF+X_I     -159801
      EUROPAM_REASON_VHF+X_I1    -159811
      EUROPAM_REASON_VHF+X_I2    -159812
      EUROPAM_REASON_VHF+X_I3    -159813
      EUROPAM_REASON_VHF+X_I4    -159814
      EUROPAM_REASON_VHF+X_I5    -159815
      EUROPAM_REASON_VHF+X_I6    -159816
      EUROPAM_REASON_VHF+X_I7    -159817
      EUROPAM_REASON_VHF+X_O     -159802
      EUROPAM_REASON_HF+X        -159803
      EUROPAM_REASON_HF+X_CS     -159831
      EUROPAM_REASON_HF+X_NS     -159832
      EUROPAM_REASON_VHF-X_I     -159804
      EUROPAM_REASON_VHF-X_I1    -159841
      EUROPAM_REASON_VHF-X_I2    -159842
      EUROPAM_REASON_VHF-X_I3    -159843
      EUROPAM_REASON_VHF-X_I4    -159844
      EUROPAM_REASON_VHF-X_I5    -159845
      EUROPAM_REASON_VHF-X_I6    -159846
      EUROPAM_REASON_VHF-X_I7    -159847
      EUROPAM_REASON_VHF-X_O     -159805
      EUROPAM_REASON_HF-X        -159806
      EUROPAM_REASON_HF-X_CS     -159861
      EUROPAM_REASON_HF-X_NS     -159862

      EUROPAM_SUDA               -159900
      EUROPAM_SUDA_KOZ           -159901
            
   Name-ID Mapping keywords:

   \begindata

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_BASE' )
      NAIF_BODY_CODE                  += ( -159100 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC' )
      NAIF_BODY_CODE                  += ( -159101 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_CLEAR' )
      NAIF_BODY_CODE                  += ( -159121 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_S_AFT' )
      NAIF_BODY_CODE                  += ( -159122 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_S_NADIR' )
      NAIF_BODY_CODE                  += ( -159123 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_S_FORE' )
      NAIF_BODY_CODE                  += ( -159124 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_NUV' )
      NAIF_BODY_CODE                  += ( -159125 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_BLU' )
      NAIF_BODY_CODE                  += ( -159126 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_GRN' )
      NAIF_BODY_CODE                  += ( -159127 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_RED' )
      NAIF_BODY_CODE                  += ( -159128 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_IR1' )
      NAIF_BODY_CODE                  += ( -159129 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_1MU' )
      NAIF_BODY_CODE                  += ( -159130 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_COLOR' )
      NAIF_BODY_CODE                  += ( -159131 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC' )
      NAIF_BODY_CODE                  += ( -159102 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_CLEAR' )
      NAIF_BODY_CODE                  += ( -159141 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_S_AFT' )
      NAIF_BODY_CODE                  += ( -159142 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_S_NADIR' )
      NAIF_BODY_CODE                  += ( -159143 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_S_FORE' )
      NAIF_BODY_CODE                  += ( -159144 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_NUV' )
      NAIF_BODY_CODE                  += ( -159145 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_BLU' )
      NAIF_BODY_CODE                  += ( -159146 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_GRN' )
      NAIF_BODY_CODE                  += ( -159147 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_RED' )
      NAIF_BODY_CODE                  += ( -159148 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_IR1' )
      NAIF_BODY_CODE                  += ( -159149 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_1MU' )
      NAIF_BODY_CODE                  += ( -159150 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_COLOR' )
      NAIF_BODY_CODE                  += ( -159151 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_RAD' )
      NAIF_BODY_CODE                  += ( -159110 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_RAD' )
      NAIF_BODY_CODE                  += ( -159111 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_NAC_KOZ' )
      NAIF_BODY_CODE                  += ( -159112 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_EIS_WAC_KOZ' )
      NAIF_BODY_CODE                  += ( -159113 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ETHEMIS' )
      NAIF_BODY_CODE                  += ( -159200 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ETHEMIS_KOZ' )
      NAIF_BODY_CODE                  += ( -159201 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ETHEMIS_RAD1' )
      NAIF_BODY_CODE                  += ( -159202 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ETHEMIS_RAD2' )
      NAIF_BODY_CODE                  += ( -159203 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ETHEMIS_BAND1' )
      NAIF_BODY_CODE                  += ( -159210 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ETHEMIS_BAND2' )
      NAIF_BODY_CODE                  += ( -159220 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ETHEMIS_BAND3' )
      NAIF_BODY_CODE                  += ( -159230 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_UVS_AP' )
      NAIF_BODY_CODE                  += ( -159300 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_UVS_SP' )
      NAIF_BODY_CODE                  += ( -159301 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_UVS_RAD' )
      NAIF_BODY_CODE                  += ( -159310 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_UVS_AP_KOZ_10' )
      NAIF_BODY_CODE                  += ( -159320 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_UVS_AP_KOZ_20' )
      NAIF_BODY_CODE                  += ( -159321 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_UVS_SP_KOZ' )
      NAIF_BODY_CODE                  += ( -159330 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ECM' )
      NAIF_BODY_CODE                  += ( -159400 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ECM_FG1' )
      NAIF_BODY_CODE                  += ( -159402 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ECM_FG2' )
      NAIF_BODY_CODE                  += ( -159404 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_ECM_FG3' )
      NAIF_BODY_CODE                  += ( -159406 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MASPEX' )
      NAIF_BODY_CODE                  += ( -159500 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MASPEX_KOZ' )
      NAIF_BODY_CODE                  += ( -159502 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MISE_BASE' )
      NAIF_BODY_CODE                  += ( -159600 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MISE' )
      NAIF_BODY_CODE                  += ( -159601 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MISE_FOR' )
      NAIF_BODY_CODE                  += ( -159602 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MISE_GLOBAL' )
      NAIF_BODY_CODE                  += ( -159603 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MISE_KOZ' )
      NAIF_BODY_CODE                  += ( -159604 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MISE_RAD1+Y' )
      NAIF_BODY_CODE                  += ( -159610 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MISE_RAD1+X' )
      NAIF_BODY_CODE                  += ( -159611 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MISE_RAD2+Y' )
      NAIF_BODY_CODE                  += ( -159612 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_MISE_RAD2+X' )
      NAIF_BODY_CODE                  += ( -159613 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_PIMS_RAM' )
      NAIF_BODY_CODE                  += ( -159700 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_PIMS_ANTI_RAM' )
      NAIF_BODY_CODE                  += ( -159701 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_PIMS_NADIR' )
      NAIF_BODY_CODE                  += ( -159702 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_PIMS_ANTI_NADIR' )
      NAIF_BODY_CODE                  += ( -159703 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON' )
      NAIF_BODY_CODE                  += ( -159800 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF+X_I' )
      NAIF_BODY_CODE                  += ( -159801 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF+X_I1' )
      NAIF_BODY_CODE                  += ( -159811 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF+X_I2' )
      NAIF_BODY_CODE                  += ( -159812 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF+X_I3' )
      NAIF_BODY_CODE                  += ( -159813 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF+X_I4' )
      NAIF_BODY_CODE                  += ( -159814 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF+X_I5' )
      NAIF_BODY_CODE                  += ( -159815 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF+X_I6' )
      NAIF_BODY_CODE                  += ( -159816 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF+X_I7' )
      NAIF_BODY_CODE                  += ( -159817 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF+X_O' )
      NAIF_BODY_CODE                  += ( -159802 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_HF+X' )
      NAIF_BODY_CODE                  += ( -159803 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_HF+X_CS' )
      NAIF_BODY_CODE                  += ( -159831 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_HF+X_NS' )
      NAIF_BODY_CODE                  += ( -159832 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF-X_I' )
      NAIF_BODY_CODE                  += ( -159804 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF-X_I1' )
      NAIF_BODY_CODE                  += ( -159841 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF-X_I2' )
      NAIF_BODY_CODE                  += ( -159842 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF-X_I3' )
      NAIF_BODY_CODE                  += ( -159843 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF-X_I4' )
      NAIF_BODY_CODE                  += ( -159844 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF-X_I5' )
      NAIF_BODY_CODE                  += ( -159845 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF-X_I6' )
      NAIF_BODY_CODE                  += ( -159846 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF-X_I7' )
      NAIF_BODY_CODE                  += ( -159847 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_VHF-X_O' )
      NAIF_BODY_CODE                  += ( -159805 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_HF-X' )
      NAIF_BODY_CODE                  += ( -159806 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_HF-X_CS' )
      NAIF_BODY_CODE                  += ( -159861 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_REASON_HF-X_NS' )
      NAIF_BODY_CODE                  += ( -159862 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_SUDA' )
      NAIF_BODY_CODE                  += ( -159900 )

      NAIF_BODY_NAME                  += ( 'EUROPAM_SUDA_KOZ' )
      NAIF_BODY_CODE                  += ( -159901 )

   \begintext

End of FK file.
