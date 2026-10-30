<p align="center">
  <img src="app-icon.png" width="180" alt="H.A.T.E. icon: pop-art vampire lips with dripping fangs">
</p>

<h1 align="center">H.A.T.E.</h1>

<p align="center">A macOS-style terminal for Windows.</p>

## Build

You need [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/) and the MSVC build tools.

```powershell
npm install
npm run tauri build
```

The installer ends up in `src-tauri/target/release/bundle/`.
