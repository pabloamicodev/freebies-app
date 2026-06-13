import { useEffect } from "react";
import { Outlet } from "react-router";

export function RootApp() {
  useEffect(() => {
    document.getElementById("app-initial-loader")?.remove();
  }, []);
  return <Outlet />;
}
