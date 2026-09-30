import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PortalApp } from "./PortalApp";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{location.pathname.endsWith("/portal.html") ? <PortalApp /> : <App />}</React.StrictMode>,
);
