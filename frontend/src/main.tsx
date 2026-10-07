import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <p>DC Dashboard</p>
  </StrictMode>,
);
