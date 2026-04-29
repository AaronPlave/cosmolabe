KPL/FK


EUROPAM Dynamic Frames Kernel
========================================================================

   This is a placeholder FK for Europa Clipper dynamic frames.


Version and Date
========================================================================


   Version 0.6 -- August 19, 2022 -- Ben Bradley, Clipper MPT

      Added the EARTH_CG_ECLPOLE_SUN frame.

   Version 0.5 -- November 23, 2021 -- Ben Bradley, Clipper MPT

      Added the MARS_CG_ECLPOLE_SUN frame.
      Added the JUPITER_CG_ECLPOLE_SUN frame.

   Version 0.4 -- January 11, 2021 -- Matt Barnes, NAIF

      Added the EUROPAM_CALLISTO_E_PHI_O frame.

   Version 0.3 -- July 10, 2020 -- Ben Bradley, MPT
                                   Boris Semenov, NAIF

      Added nadir-style frames for Ganymede and Callisto
      (EUROPAM_CG_G_POLE_NADIR and EUROPAM_CG_C_POLE_NADIR),
      respectively.  These are similar to the Europa counterpart.

      Also Added the EUROPAM_CG_ECLPOLE_EARTH and 
      EUROPAM_CG_ECLPOLE_JUP frames.


   Version 0.2 -- July 07, 2020 -- Ben Bradley, MPT
                                   Boris Semenov, NAIF

      Added the EUROPAM_CG_E_POLE_NADIR frame.

   Version 0.1 -- December 18, 2019 -- Boris Semenov, NAIF

      Added the EUROPAM_EUROPA_E_PHI_O frame.

   Version 0.0 -- November 15, 2017 -- Boris Semenov, NAIF

      Initial version; includes the EUROPAM_JUP_POLE_EUROPA and 
      EUROPAM_JUP_EUROPA_POLE frames.


References
========================================================================

   1. ``Frames Required Reading''

   2. ``Kernel Pool Required Reading''

   3. E-mail ``RE: spacecraft frame kernel'' from Corey Cochrane, JPL,
      from November 15, 2017

   4. E-mail ``E Phi O Europa reference frame'' from Corey Cochrane, JPL,
      from December 17, 2019

   5. E-mail ``Meeting about Using SPICE Frames in Cosmographia'' from 
      Ben Bradley, JPL, from July 6, 2020

   6. E-mail ``E Phi O Europa reference frame'' from Corey Cochrane, JPL,
      from January 7, 2021


Frames Definitions
========================================================================

   This FK currently defines the following dynamic frames of use to ECM
   (with IDs in the -159951 ... -159969 range):

      EUROPAM_JUP_POLE_EUROPA (-159951), per [3]:

         -- +Z is aligned with the Jupiter pole (primary axis) 
         -- +X is in the direction Jupiter-Europa vector (secondary axis)
         -- centered on Jupiter

      EUROPAM_JUP_EUROPA_POLE (-159952), per [3]:

         -- +X is aligned with the Jupiter-Europa vector (primary axis)
         -- +Z is in the direction of Jupiter pole (secondary axis)
         -- centered on Jupiter

      EUROPAM_EUROPA_E_PHI_O (-159953), per [4]:

         -- +Z is aligned with the Jupiter pole (primary axis) 
         -- +Y is in the direction Europa-Jupiter vector (secondary axis)
         -- centered on Europa

      EUROPAM_CALLISTO_E_PHI_O (-159954), per [6]:

         -- +Z is aligned with the Jupiter pole (primary axis) 
         -- +Y is in the direction Callisto-Jupiter vector (secondary axis)
         -- centered on Callisto

   This FK also defines the following dynamic frames for Cosmographia 
   animation purposes (named EUROPAM_CG_* with IDs in the -159971 ... 
   -159989 range):

      EUROPAM_CG_E_POLE_NADIR (-159971), per [5]:

         -- +Y is aligned with the Clipper FS-Europa vector (primary axis)
         -- +Z is in the direction of Europa pole (secondary axis)
         -- centered on Clipper FS (-159)

      EUROPAM_CG_G_POLE_NADIR (-159972):

         -- +Y is aligned with the Clipper FS-Ganymede vector (primary axis)
         -- +Z is in the direction of Ganymede pole (secondary axis)
         -- centered on Clipper FS (-159)

      EUROPAM_CG_C_POLE_NADIR (-159973):

         -- +Y is aligned with the Clipper FS-Callisto vector (primary axis)
         -- +Z is in the direction of Callisto pole (secondary axis)
         -- centered on Clipper FS (-159)

      EUROPAM_CG_ECLPOLE_EARTH (-159974):

         -- +Y is aligned with the Clipper FS-Earth vector (primary axis)
         -- +Z is in the direction of ECLIPJ2000 north pole (secondary axis)
         -- centered on Clipper FS (-159)

      EUROPAM_CG_ECLPOLE_JUP (-159975):

         -- +Y is aligned with the Clipper FS-Jupiter vector (primary axis)
         -- +Z is in the direction of ECLIPJ2000 north pole (secondary axis)
         -- centered on Clipper FS (-159)

      MARS_CG_ECLPOLE_SUN (-159976):

         -- +Y is aligned with the Mars-Sun vector (primary axis)
         -- +Z is in the direction of ECLIPJ2000 north pole (secondary axis)
         -- centered on Mars (499)

      JUPITER_CG_ECLPOLE_SUN (-159977):

         -- +Y is aligned with the Jupiter-Sun vector (primary axis)
         -- +Z is in the direction of ECLIPJ2000 north pole (secondary axis)
         -- centered on Jupiter (599)

      EARTH_CG_ECLPOLE_SUN (-159978):

         -- +Y is aligned with the Earth-Sun vector (primary axis)
         -- +Z is in the direction of ECLIPJ2000 north pole (secondary axis)
         -- centered on Earth (399)


   \begindata

      FRAME_EUROPAM_JUP_POLE_EUROPA =  -159951
      FRAME_-159951_NAME             = 'EUROPAM_JUP_POLE_EUROPA'
      FRAME_-159951_CLASS            =  5
      FRAME_-159951_CLASS_ID         =  -159951
      FRAME_-159951_CENTER           =  599
      FRAME_-159951_RELATIVE         = 'J2000'
      FRAME_-159951_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159951_FAMILY           = 'TWO-VECTOR'
      FRAME_-159951_PRI_AXIS         = 'Z'
      FRAME_-159951_PRI_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159951_PRI_FRAME        = 'IAU_JUPITER'
      FRAME_-159951_PRI_SPEC         = 'RECTANGULAR'
      FRAME_-159951_PRI_VECTOR       = ( 0, 0, 1 )
      FRAME_-159951_SEC_AXIS         = 'X'
      FRAME_-159951_SEC_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159951_SEC_OBSERVER     = 'JUPITER'
      FRAME_-159951_SEC_TARGET       = 'EUROPA'
      FRAME_-159951_SEC_ABCORR       = 'NONE'

      FRAME_EUROPAM_JUP_EUROPA_POLE =  -159952
      FRAME_-159952_NAME             = 'EUROPAM_JUP_EUROPA_POLE'
      FRAME_-159952_CLASS            =  5
      FRAME_-159952_CLASS_ID         =  -159952
      FRAME_-159952_CENTER           =  599
      FRAME_-159952_RELATIVE         = 'J2000'
      FRAME_-159952_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159952_FAMILY           = 'TWO-VECTOR'
      FRAME_-159952_PRI_AXIS         = 'X'
      FRAME_-159952_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159952_PRI_OBSERVER     = 'JUPITER'
      FRAME_-159952_PRI_TARGET       = 'EUROPA'
      FRAME_-159952_PRI_ABCORR       = 'NONE'
      FRAME_-159952_SEC_AXIS         = 'Z'
      FRAME_-159952_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159952_SEC_FRAME        = 'IAU_JUPITER'
      FRAME_-159952_SEC_SPEC         = 'RECTANGULAR'
      FRAME_-159952_SEC_VECTOR       = ( 0, 0, 1 )

      FRAME_EUROPAM_EUROPA_E_PHI_O   =  -159953
      FRAME_-159953_NAME             = 'EUROPAM_EUROPA_E_PHI_O'
      FRAME_-159953_CLASS            =  5
      FRAME_-159953_CLASS_ID         =  -159953
      FRAME_-159953_CENTER           =  502
      FRAME_-159953_RELATIVE         = 'J2000'
      FRAME_-159953_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159953_FAMILY           = 'TWO-VECTOR'
      FRAME_-159953_PRI_AXIS         = 'Z'
      FRAME_-159953_PRI_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159953_PRI_FRAME        = 'IAU_JUPITER'
      FRAME_-159953_PRI_SPEC         = 'RECTANGULAR'
      FRAME_-159953_PRI_VECTOR       = ( 0, 0, 1 )
      FRAME_-159953_SEC_AXIS         = 'Y'
      FRAME_-159953_SEC_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159953_SEC_OBSERVER     = 'EUROPA'
      FRAME_-159953_SEC_TARGET       = 'JUPITER'
      FRAME_-159953_SEC_ABCORR       = 'NONE'

      FRAME_EUROPAM_CALLISTO_E_PHI_O =  -159954
      FRAME_-159954_NAME             = 'EUROPAM_CALLISTO_E_PHI_O'
      FRAME_-159954_CLASS            =  5
      FRAME_-159954_CLASS_ID         =  -159954
      FRAME_-159954_CENTER           =  504
      FRAME_-159954_RELATIVE         = 'J2000'
      FRAME_-159954_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159954_FAMILY           = 'TWO-VECTOR'
      FRAME_-159954_PRI_AXIS         = 'Z'
      FRAME_-159954_PRI_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159954_PRI_FRAME        = 'IAU_JUPITER'
      FRAME_-159954_PRI_SPEC         = 'RECTANGULAR'
      FRAME_-159954_PRI_VECTOR       = ( 0, 0, 1 )
      FRAME_-159954_SEC_AXIS         = 'Y'
      FRAME_-159954_SEC_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159954_SEC_OBSERVER     = 'CALLISTO'
      FRAME_-159954_SEC_TARGET       = 'JUPITER'
      FRAME_-159954_SEC_ABCORR       = 'NONE'

      FRAME_EUROPAM_CG_E_POLE_NADIR  =  -159971
      FRAME_-159971_NAME             = 'EUROPAM_CG_E_POLE_NADIR'
      FRAME_-159971_CLASS            =  5
      FRAME_-159971_CLASS_ID         =  -159971
      FRAME_-159971_CENTER           =  -159
      FRAME_-159971_RELATIVE         = 'J2000'
      FRAME_-159971_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159971_FAMILY           = 'TWO-VECTOR'
      FRAME_-159971_PRI_AXIS         = 'Y'
      FRAME_-159971_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159971_PRI_OBSERVER     = '-159'
      FRAME_-159971_PRI_TARGET       = 'EUROPA'
      FRAME_-159971_PRI_ABCORR       = 'NONE'
      FRAME_-159971_SEC_AXIS         = 'Z'
      FRAME_-159971_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159971_SEC_FRAME        = 'IAU_EUROPA'
      FRAME_-159971_SEC_SPEC         = 'RECTANGULAR'
      FRAME_-159971_SEC_VECTOR       = ( 0, 0, 1 )

      FRAME_EUROPAM_CG_G_POLE_NADIR  =  -159972
      FRAME_-159972_NAME             = 'EUROPAM_CG_G_POLE_NADIR'
      FRAME_-159972_CLASS            =  5
      FRAME_-159972_CLASS_ID         =  -159972
      FRAME_-159972_CENTER           =  -159
      FRAME_-159972_RELATIVE         = 'J2000'
      FRAME_-159972_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159972_FAMILY           = 'TWO-VECTOR'
      FRAME_-159972_PRI_AXIS         = 'Y'
      FRAME_-159972_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159972_PRI_OBSERVER     = '-159'
      FRAME_-159972_PRI_TARGET       = 'GANYMEDE'
      FRAME_-159972_PRI_ABCORR       = 'NONE'
      FRAME_-159972_SEC_AXIS         = 'Z'
      FRAME_-159972_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159972_SEC_FRAME        = 'IAU_GANYMEDE'
      FRAME_-159972_SEC_SPEC         = 'RECTANGULAR'
      FRAME_-159972_SEC_VECTOR       = ( 0, 0, 1 )

      FRAME_EUROPAM_CG_C_POLE_NADIR  =  -159973
      FRAME_-159973_NAME             = 'EUROPAM_CG_C_POLE_NADIR'
      FRAME_-159973_CLASS            =  5
      FRAME_-159973_CLASS_ID         =  -159973
      FRAME_-159973_CENTER           =  -159
      FRAME_-159973_RELATIVE         = 'J2000'
      FRAME_-159973_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159973_FAMILY           = 'TWO-VECTOR'
      FRAME_-159973_PRI_AXIS         = 'Y'
      FRAME_-159973_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159973_PRI_OBSERVER     = '-159'
      FRAME_-159973_PRI_TARGET       = 'CALLISTO'
      FRAME_-159973_PRI_ABCORR       = 'NONE'
      FRAME_-159973_SEC_AXIS         = 'Z'
      FRAME_-159973_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159973_SEC_FRAME        = 'IAU_CALLISTO'
      FRAME_-159973_SEC_SPEC         = 'RECTANGULAR'
      FRAME_-159973_SEC_VECTOR       = ( 0, 0, 1 )

      FRAME_EUROPAM_CG_ECLPOLE_EARTH =  -159974
      FRAME_-159974_NAME             = 'EUROPAM_CG_ECLPOLE_EARTH'
      FRAME_-159974_CLASS            =  5
      FRAME_-159974_CLASS_ID         =  -159974
      FRAME_-159974_CENTER           =  -159
      FRAME_-159974_RELATIVE         = 'J2000'
      FRAME_-159974_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159974_FAMILY           = 'TWO-VECTOR'
      FRAME_-159974_PRI_AXIS         = 'Y'
      FRAME_-159974_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159974_PRI_OBSERVER     = '-159'
      FRAME_-159974_PRI_TARGET       = 'EARTH'
      FRAME_-159974_PRI_ABCORR       = 'NONE'
      FRAME_-159974_SEC_AXIS         = 'Z'
      FRAME_-159974_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159974_SEC_FRAME        = 'ECLIPJ2000'
      FRAME_-159974_SEC_SPEC         = 'RECTANGULAR'
      FRAME_-159974_SEC_VECTOR       = ( 0, 0, 1 )

      FRAME_EUROPAM_CG_ECLPOLE_JUP =  -159975
      FRAME_-159975_NAME             = 'EUROPAM_CG_ECLPOLE_JUP'
      FRAME_-159975_CLASS            =  5
      FRAME_-159975_CLASS_ID         =  -159975
      FRAME_-159975_CENTER           =  -159
      FRAME_-159975_RELATIVE         = 'J2000'
      FRAME_-159975_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159975_FAMILY           = 'TWO-VECTOR'
      FRAME_-159975_PRI_AXIS         = 'Y'
      FRAME_-159975_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159975_PRI_OBSERVER     = '-159'
      FRAME_-159975_PRI_TARGET       = 'JUPITER'
      FRAME_-159975_PRI_ABCORR       = 'NONE'
      FRAME_-159975_SEC_AXIS         = 'Z'
      FRAME_-159975_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159975_SEC_FRAME        = 'ECLIPJ2000'
      FRAME_-159975_SEC_SPEC         = 'RECTANGULAR'
      FRAME_-159975_SEC_VECTOR       = ( 0, 0, 1 )

      FRAME_MARS_CG_ECLPOLE_SUN      =  -159976
      FRAME_-159976_NAME             = 'MARS_CG_ECLPOLE_SUN'
      FRAME_-159976_CLASS            =  5
      FRAME_-159976_CLASS_ID         =  -159976
      FRAME_-159976_CENTER           =  499
      FRAME_-159976_RELATIVE         = 'J2000'
      FRAME_-159976_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159976_FAMILY           = 'TWO-VECTOR'
      FRAME_-159976_PRI_AXIS         = 'Y'
      FRAME_-159976_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159976_PRI_OBSERVER     = '499'
      FRAME_-159976_PRI_TARGET       = 'SUN'
      FRAME_-159976_PRI_ABCORR       = 'NONE'
      FRAME_-159976_SEC_AXIS         = 'Z'
      FRAME_-159976_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159976_SEC_FRAME        = 'ECLIPJ2000'
      FRAME_-159976_SEC_SPEC         = 'RECTANGULAR'
      FRAME_-159976_SEC_VECTOR       = ( 0, 0, 1 )

      FRAME_JUPITER_CG_ECLPOLE_SUN   =  -159977
      FRAME_-159977_NAME             = 'JUPITER_CG_ECLPOLE_SUN'
      FRAME_-159977_CLASS            =  5
      FRAME_-159977_CLASS_ID         =  -159977
      FRAME_-159977_CENTER           =  599
      FRAME_-159977_RELATIVE         = 'J2000'
      FRAME_-159977_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159977_FAMILY           = 'TWO-VECTOR'
      FRAME_-159977_PRI_AXIS         = 'Y'
      FRAME_-159977_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159977_PRI_OBSERVER     = '599'
      FRAME_-159977_PRI_TARGET       = 'SUN'
      FRAME_-159977_PRI_ABCORR       = 'NONE'
      FRAME_-159977_SEC_AXIS         = 'Z'
      FRAME_-159977_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159977_SEC_FRAME        = 'ECLIPJ2000'
      FRAME_-159977_SEC_SPEC         = 'RECTANGULAR'
      FRAME_-159977_SEC_VECTOR       = ( 0, 0, 1 )


      FRAME_EARTH_CG_ECLPOLE_SUN     =  -159978
      FRAME_-159978_NAME             = 'EARTH_CG_ECLPOLE_SUN'
      FRAME_-159978_CLASS            =  5
      FRAME_-159978_CLASS_ID         =  -159978
      FRAME_-159978_CENTER           =  399
      FRAME_-159978_RELATIVE         = 'J2000'
      FRAME_-159978_DEF_STYLE        = 'PARAMETERIZED'
      FRAME_-159978_FAMILY           = 'TWO-VECTOR'
      FRAME_-159978_PRI_AXIS         = 'Y'
      FRAME_-159978_PRI_VECTOR_DEF   = 'OBSERVER_TARGET_POSITION'
      FRAME_-159978_PRI_OBSERVER     = '399'
      FRAME_-159978_PRI_TARGET       = 'SUN'
      FRAME_-159978_PRI_ABCORR       = 'NONE'
      FRAME_-159978_SEC_AXIS         = 'Z'
      FRAME_-159978_SEC_VECTOR_DEF   = 'CONSTANT'
      FRAME_-159978_SEC_FRAME        = 'ECLIPJ2000'
      FRAME_-159978_SEC_SPEC         = 'RECTANGULAR'
      FRAME_-159978_SEC_VECTOR       = ( 0, 0, 1 )

   \begintext

End of FK.
