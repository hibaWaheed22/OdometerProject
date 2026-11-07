# Fleet Fuel Manager - HTML + CSS + JavaScript version (no Python needed)

Double-click `index.html` (or `fleet_manager_single.html`) and it opens in the browser. Nothing to install.

| File | Job |
|---|---|
| `index.html` | the page structure (tabs, forms, dialogs) |
| `style.css` | colours and layout (change the colours in `:root` at the top) |
| `app.js` | draws the screens, charts, odometer and gauge; reads what the user types |
| `store.js` | the "database" and every rule and calculation (km/L, cost per km, checks, alerts) |
| `data.js` | demo data: 6 vehicles, 72 refuellings, 15 maintenance records |
| `fleet_manager_single.html` | the same app in ONE file (all five files inside it) |

Data is saved in the browser (localStorage), so it stays after you close the page. It is per browser and per computer. Clearing the browser's site data deletes it (the app then offers "Load demo data"). Rules, formulas and thresholds are explained in the Data & export tab and as comments at the top of `store.js`.
