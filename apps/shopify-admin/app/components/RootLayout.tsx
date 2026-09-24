import { Links, Meta, Scripts, ScrollRestoration } from "react-router";
import type { ReactNode } from "react";

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning prevents React from failing hydration when
    // browser extensions add attributes to html/body that the server didn't render.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <Meta />
        <Links />
      </head>
      <body suppressHydrationWarning>
        <div id="app-initial-loader" style={{
          position: "fixed", inset: 0, zIndex: 2147483647,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "#f6f6f7",
        }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 10,
            padding: "0 16px", minHeight: 40,
            background: "rgba(255,255,255,0.92)", borderRadius: 999,
            border: "1px solid rgba(28,25,23,0.10)",
            boxShadow: "0 8px 24px rgba(28,25,23,0.12)",
            fontSize: 13, fontWeight: 600, fontFamily: "system-ui, sans-serif",
            color: "#1c1917",
          }}>
            <span style={{ display: "inline-flex", gap: 3 }}>
              {[0, 110, 220].map((delay) => (
                <span key={delay} style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: delay === 0 ? "#2c6ecb" : delay === 110 ? "#10b981" : "#f59e0b",
                  animation: `b-dot 850ms ease-in-out ${delay}ms infinite`,
                }} />
              ))}
            </span>
            Loading
          </div>
          <style>{`@keyframes b-dot{0%,80%,100%{transform:scale(0.6);opacity:0.4}40%{transform:scale(1);opacity:1}}`}</style>
        </div>
        {/* Safety net: if React never mounts (a hydration crash, a script
            blocked by an ad blocker/CSP), the loader above would otherwise
            spin forever with no way out for the merchant. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `setTimeout(function(){var el=document.getElementById("app-initial-loader");if(el){el.innerHTML='<div style="text-align:center;font-family:system-ui,sans-serif;color:#1c1917"><p style="font-weight:600;margin:0 0 8px">This is taking longer than expected</p><button onclick="location.reload()" style="padding:8px 16px;border-radius:999px;border:1px solid rgba(28,25,23,0.15);background:#fff;cursor:pointer;font:inherit">Reload</button></div>';}},15000);`,
          }}
        />
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
