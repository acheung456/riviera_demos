# Riviera Demos

This repository is set up as a GitHub Pages-friendly collection of Riviera API demos.

## Structure

```text
/
├── index.html
├── assets/
│   ├── styles.css
│   └── transcription.js
└── demos/
    └── transcription/
        └── index.html
```

## Current demo

- `demos/transcription/` shows how to call the Riviera async transcription API from a static page.
- URL mode sends `file_id_or_url` as `{ ".tag": "url", "url": "..." }`.
- File mode uploads the selected file to Dropbox first, then sends the returned `file_id` into Riviera.
- Authentication uses Dropbox OAuth code flow with PKCE in the browser.

## GitHub Pages deployment

- The repo includes a Pages workflow at [.github/workflows/deploy-pages.yml](/Users/acheung/src/personal/riviera_demos/.github/workflows/deploy-pages.yml).
- The workflow publishes the static site and generates `assets/runtime-config.js` from the repository variable `DROPBOX_APP_KEY`.
- In the Dropbox App Console, register your deployed transcription page URL as an exact redirect URI.

Recommended redirect URIs for this project:

- `https://acheung456.github.io/riviera_demos/demos/transcription/`
- `http://127.0.0.1:4173/demos/transcription/` for local preview

## Dropbox app setup

- Use a scoped Dropbox app.
- Enable at least `files.content.read` and `files.content.write`.
- Prefer PKCE and disable the implicit grant if you are not using it.

## Notes

- Because this is a static GitHub Pages site, the browser performs the OAuth PKCE flow directly.
- The app key is public by design, but the client secret is never shipped to the browser.
