# DroneTogs local working version

This version runs a local Node server and filters NOAA AviationWeather cache files server-side.
It avoids browser CORS and avoids fragile bbox API calls.

## Run on Mac

1. Unzip this folder.
2. Open the unzipped folder.
3. Right-click inside the folder and choose **New Terminal at Folder**.
4. Run:

```bash
npm install
npm start
```

5. Open:

```text
http://localhost:3000
```

Do not double-click `index.html`.

## Test endpoint

After `npm start`, open:

```text
http://localhost:3000/api/nearby?lat=40.6413&lon=-73.7781
```

You should see JSON with `metars` and `tafs`.
