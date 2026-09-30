import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const builtDashboard = resolve(root, "v2-assets/index.html");

await Promise.all([
  copyFile(builtDashboard, resolve(root, "dashboard.html")),
  copyFile(builtDashboard, resolve(root, "dashboard-v2.html")),
  copyFile(builtDashboard, resolve(root, "portal.html")),
]);
console.log("Published dashboard.html, dashboard-v2.html and portal.html");
