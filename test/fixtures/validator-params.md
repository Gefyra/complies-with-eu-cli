# Java validator parameters
# One flag per line. Lines starting with '#' are comments.

-version 4.0.1
-tx n/a
-ig de.basisprofil.r4#1.5.4
-level warnings
-output /tmp/should-be-dropped.json
-html-output /tmp/should-be-dropped.html
-proxy some host:8080
-allow-example-urls true
-debug
not a flag line
  -indented-flag   value with  spaces  
