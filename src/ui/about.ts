// The "About accuracy" dialog: opened from the caveats line and the footer.
export function initAbout(dialog: HTMLDialogElement) {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-open-about]')) {
    btn.addEventListener('click', () => {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', ''); // very old browsers: show inline
    });
  }
  // Click on the backdrop closes it, like Escape does.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}
