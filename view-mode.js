(() => {
  "use strict";

  const storageKey = "trpg-audience-view-mode";
  const buttons = [...document.querySelectorAll("[data-audience-mode]")];

  function applyMode(mode) {
    const selectedMode = mode === "public" ? "public" : "private";
    document.body.dataset.audienceMode = selectedMode;
    buttons.forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.audienceMode === selectedMode));
    });
    window.dispatchEvent(new CustomEvent("audience-mode-change", { detail: { mode: selectedMode } }));
  }

  let savedMode = "private";
  try {
    savedMode = localStorage.getItem(storageKey) || savedMode;
  } catch {}
  applyMode(savedMode);

  buttons.forEach(button => {
    button.addEventListener("click", () => {
      const mode = button.dataset.audienceMode;
      applyMode(mode);
      try {
        localStorage.setItem(storageKey, mode);
      } catch {}
    });
  });

  window.addEventListener("storage", event => {
    if (event.key === storageKey) applyMode(event.newValue);
  });
})();