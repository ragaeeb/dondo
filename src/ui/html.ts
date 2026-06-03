export const renderHtml = () => {
    const assetVersion = Date.now();
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dondo</title>
  <link rel="icon" href="/icon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/icon.png" />
  <link rel="stylesheet" href="/assets/styles.css?v=${assetVersion}" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/app.js?v=${assetVersion}"></script>
</body>
</html>`;
};
