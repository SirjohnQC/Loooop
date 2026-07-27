# Ideas

## Done
- [DONE 2026-07-27] When opening the terminal make sure to assign a color and name the convo matching the proper project within the terminal
  - Implemented via Windows Terminal `--title <project>` and a deterministic
    `--tabColor` per project. Note: `/color` and `/rename` aren't standard Claude
    Code slash-commands, so the terminal's native flags are used instead.

## Backlog
-Make an AI choose if it continue or not by taking the choixe available in the terminal after being stopped by rate limit
-Add full gui window for more settings(managing favorite and project, notificatio, timer threshold before resuming,launch at startup,etc)
-Add the option to start minimized with windows
-Analyzing request (like when terminal get stuck on yes or no qquestion the AI could enter and take the decision or send me a notifiction if I want to accept or not)
-Hide the app terminal when launching
