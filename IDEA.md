# Ideas

## Done
- [DONE 2026-07-27] When opening the terminal make sure to assign a color and name the convo matching the proper project within the terminal
  - Implemented via Windows Terminal `--title <project>` and a deterministic
    `--tabColor` per project. Note: `/color` and `/rename` aren't standard Claude
    Code slash-commands, so the terminal's native flags are used instead.

## Backlog
-Make an AI choose if it continue or not by taking the choice available in the terminal after being stopped by rate limit
-Add full gui window for more settings(managing favorite and project, notificatio, timer threshold before resuming,launch at startup,etc)
-Add the option to start minimized with windows
-Analyzing request (like when terminal get stuck on yes or no qquestion the AI could enter and take the decision or send me a notifiction if I want to accept or not)
-Hide the app terminal when launching
-First time when we launch loooop from a new project folder it should create a file/skills that would be the main reference for the loop when another AI agent will make the call when questions get ask by claude or need to continue the project (press yes, no, etc).
Since I have a gemini pro sub , whe should try with this one first.
-tray notification about session about to run out of token (custom threshold in the settings)