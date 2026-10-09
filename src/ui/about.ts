// Pop-up dialogs: "About accuracy" (opened from the caveats line and the footer) and Basic's
// "About these numbers".
export function initDialog(dialog: HTMLDialogElement, openers: Iterable<HTMLElement>) {
  for (const btn of openers) {
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

export function initAbout(dialog: HTMLDialogElement) {
  initDialog(dialog, document.querySelectorAll<HTMLButtonElement>('[data-open-about]'));
}
