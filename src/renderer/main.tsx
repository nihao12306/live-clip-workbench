import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const directOpenWarning = document.getElementById("direct-open-warning");
if (directOpenWarning && window.workbench) directOpenWarning.hidden = true;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
