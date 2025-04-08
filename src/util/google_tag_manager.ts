// Inject google tag manager script if `NEUROGLANCER_GOOGLE_TAG_MANAGER` is defined.
declare const NEUROGLANCER_GOOGLE_TAG_MANAGER: string | undefined;

if (typeof NEUROGLANCER_GOOGLE_TAG_MANAGER !== "undefined") {
  const l = "dataLayer";
  const i = NEUROGLANCER_GOOGLE_TAG_MANAGER;
  (window as any)[l] = (window as any)[l] || [];
  (window as any)[l].push({
    "gtm.start": new Date().getTime(),
    event: "gtm.js",
  });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${i}&gtm_cookies_win=x`;
  document.head.appendChild(script);
  const style = document.createElement("style");
  style.innerText = `#onetrust-consent-sdk { font-family: sans-serif; }`;
  document.head.appendChild(style);
}
