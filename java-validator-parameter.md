# Parameters for the local HL7 FHIR validator (validator_cli.jar)
#
# One option per line: "-flag" or "-key value". Lines starting with '#' are comments.
# -output and -html-output are ignored: complies-with-eu parses the console output itself.
# -ig entries for the EU packages, the validated package and its dependencies are added
# automatically. Used by `validate`, `validate-batch` and the local validator server
# in package mode.
-allow-example-urls true
-verbose
-display-issues-are-warnings
-tx n/a
-version 4.0.1
-locale en
-jurisdiction global
# de.basisprofil.r4 is loaded for every run on purpose: many German packages reference it
# without declaring it as a dependency, and existing deployments rely on it being present.
# It does not change results for packages that do not use it.
-ig de.basisprofil.r4#1.5.4
