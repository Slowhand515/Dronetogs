# DroneTogs Render fixed deployment

Render settings:
- Environment: Node
- Build Command: npm install
- Start Command: npm start

After deploy, test:
https://YOUR-RENDER-URL/api/nearby?lat=40.6413&lon=-73.7781

Or in browser console on the live app:
fetch('/api/nearby?lat=40.6413&lon=-73.7781').then(r=>r.json()).then(console.log)
