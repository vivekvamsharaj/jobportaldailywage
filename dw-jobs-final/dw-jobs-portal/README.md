# Daily Wage Jobs Portal (Telugu / English / Hindi)

One-file full-stack app: Node + Express + MongoDB backend, frontend and Leaflet map all in `server.js`.

## Features
- Languages: Telugu, English, Hindi
- Worker and employer roles (phone + password login)
- Workers see jobs within 5/10/20/30 km on a map, nearest first
- Owner location, call button and Google Maps directions
- Employer posts jobs by tapping the map, accepts/rejects applicants

## Run locally
```
npm install
set MONGO_URI=mongodb://127.0.0.1:27017/dwjobs   (Windows)  |  export MONGO_URI=...  (Mac/Linux)
npm start
```
Open http://localhost:5000

## Deploy on Render
- Build Command: `npm install`
- Start Command: `npm start`
- Environment variables:
  - `MONGO_URI` = mongodb+srv://USER:PASSWORD@cluster0.xxxx.mongodb.net/dwjobs?retryWrites=true&w=majority
  - `JWT_SECRET` = any long random text
- MongoDB Atlas > Network Access must allow 0.0.0.0/0
- GPS works only on HTTPS (Render gives HTTPS) or localhost
