# Poultry Application

Simple web app to track birds, sales and show today's summary.

Files added in this branch:
- server.js       (Express server and API)
- package.json
- public/index.html

Prerequisites
- Node.js (14+)

Run locally
1. git clone https://github.com/yalakalasaikiran6-svg/poultry-application.git
2. cd poultry-application
3. git checkout poultry-app-init
4. npm install
5. npm start
6. Open http://localhost:3000/ in your browser

Notes
- The branch depends on `schema.sql` present in the repository root (on the default branch). That file was committed earlier.
- The server creates a SQLite file `poultry.db` next to schema.sql on first run.

Create a Pull Request (from your machine)
- Using GitHub CLI:
  gh pr create --base main --head poultry-app-init --title "Add poultry web app" --body "Add server, frontend, and run instructions"

If you'd like, I can open the PR for you — tell me and I will proceed (I have pushed the branch and files already).