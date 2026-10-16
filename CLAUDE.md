# Project

This is a Typescript client built on top of Rysk Protocol on HyperEVM. It may contain several strategies for trading covered calls and cash secured puts.

# Git Handling
This repo is PUBLIC. Take care with which information you expose in code that you commit and push. Notfy the user if there is doubt about the safety of information that may have been pushed up at any point by any actor.
The `main` branch is production branch with live running scripts. Do NOT merge into or push `main`. All word you do can be merged into the `staging` branch, which will be long lived and used to run live scripts before the user merges them into `main`. Do not merge or push `main`.
Prefer fewer large high level commits over many tiny commits.
Commit messages should be high level, simple, and easy to parse. Generally they should not exceed 15 words.
When merging a feature branch into a long lived branch rebase the commits into either a single feature commit or a smaller set of commits where each commit represents a distinct feature or area of change.
You are the author and will get your credit in the git Author field. Do not additionally write that you are the co-author, which model you used, your noreply email, nor the session details in the commit messages. 

