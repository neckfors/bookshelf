// The Android app shows these same pages, with the book folder, the front pages and the screen handled
// by Android. In a browser this file does nothing.
export const app = window.AndroidBridge;

async function ask(what, params) {
  const response = await fetch(`/native/${what}?${new URLSearchParams(params)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${what}: ${response.status}`);
  return response;
}

// The chosen folder, made to look like the browser's folder access, so the rest of the app needs no changes.
export function nativeRoot(tree) {
  let listing = null;
  // Android lists the whole folder in one go; reading the top folder asks again.
  function folders(fresh) {
    if (fresh || !listing) {
      listing = ask('list', { tree }).then(r => r.json()).then(books => {
        const empty = () => ({ folders: new Map(), files: new Map() });
        const top = empty();
        for (const book of books) {
          const parts = book.path.split('/');
          let at = top;
          for (const part of parts.slice(0, -1)) {
            if (!at.folders.has(part)) at.folders.set(part, empty());
            at = at.folders.get(part);
          }
          at.files.set(parts.at(-1), book);
        }
        return top;
      });
      listing.catch(() => { listing = null; });
    }
    return listing;
  }
  const missing = name => new DOMException(`${name} is gone`, 'NotFoundError');

  const fileHandle = book => ({
    kind: 'file',
    getFile: async () => ({
      native: true,
      size: book.size,
      lastModified: book.mtime,
      slice: (start, end) => ({
        arrayBuffer: async () => (await ask('read', { tree, path: book.path, start, end: Math.min(end, book.size) })).arrayBuffer(),
      }),
      // A page as a picture that fits in the box; empty if the PDF can't be shown.
      frontPage: async (page, { maxWidth, maxHeight }) =>
        (await ask('page', { tree, path: book.path, page, w: Math.round(maxWidth), h: Math.round(maxHeight) })).blob(),
    }),
  });

  const folderHandle = parts => {
    const find = async fresh => {
      let at = await folders(fresh);
      for (const part of parts) if (!(at = at.folders.get(part))) throw missing(part);
      return at;
    };
    return {
      kind: 'directory',
      async *entries() {
        const at = await find(!parts.length);
        for (const name of at.folders.keys()) yield [name, folderHandle([...parts, name])];
        for (const [name, book] of at.files) yield [name, fileHandle(book)];
      },
      getDirectoryHandle: async name => folderHandle([...parts, name]),
      getFileHandle: async name => {
        const book = (await find()).files.get(name);
        if (!book) throw missing(name);
        return fileHandle(book);
      },
    };
  };

  return {
    ...folderHandle([]),
    stored: { native: tree }, // what is saved; the functions can't be
    isSameEntry: async other => other.stored?.native === tree,
    queryPermission: async () => app.hasAccess(tree) ? 'granted' : 'prompt',
    // Android only gives access again through the folder chooser.
    requestPermission: async () => {
      try { return (await window.showDirectoryPicker()).stored.native === tree ? 'granted' : 'denied'; }
      catch { return 'denied'; }
    },
  };
}

if (app) {
  window.showDirectoryPicker = () => new Promise((resolve, reject) => {
    window.folderPicked = tree => tree ? resolve(nativeRoot(tree)) : reject(new DOMException('Cancelled', 'AbortError'));
    app.pickFolder();
  });
  // The web view has no full screen of its own, so Android hides its bars and keeps the screen on.
  let full = null;
  Element.prototype.requestFullscreen = function () {
    full = this;
    app.setFullscreen(true);
    return Promise.resolve();
  };
  document.exitFullscreen = () => {
    full = null;
    app.setFullscreen(false);
    return Promise.resolve();
  };
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full });
}
