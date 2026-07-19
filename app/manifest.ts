import type { MetadataRoute } from "next";

/**
 * PWA manifest. Next serves this at /manifest.webmanifest and links it
 * automatically. iOS uses the apple-icon (app/apple-icon.png) for the Home
 * Screen icon and ignores these `icons`; they are here for Android and general
 * installability. Colours match the app's warm-paper theme so the splash and
 * status bar do not flash a different shade on launch.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Flâneur",
    short_name: "Flâneur",
    description:
      "Photograph something in Hong Kong — find what it costs, or find where to buy one like it.",
    start_url: "/",
    display: "standalone",
    background_color: "#ece8dd",
    theme_color: "#ece8dd",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
