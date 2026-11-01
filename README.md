# Yomu — setup guide

Yomu is a reading app for Japanese EPUB books. Tap a word to see its reading and meaning, and add it to a jpdb deck with one tap. Readings come from jpdb, which looks at the whole sentence to pick the right one.

Your books and your jpdb key stay on your phone. The app only talks to jpdb.io.

## 1. Put the app online (once, about 10 minutes, easiest on a computer)

The app is a folder of files. GitHub Pages hosts it for free.

1. Sign in to github.com (or create a free account).
2. Create a new repository named `yomu`. Set it to **Public** (free hosting requires this; the repository only holds the app's code, never your books or key).
3. On the new repository's page, choose **Add file → Upload files**. Drag in everything inside the `yomu` folder (`index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, and the `icons` and `vendor` folders). Choose **Commit changes**.
4. Go to **Settings → Pages**. Under "Branch", choose `main` and `/ (root)`, then **Save**.
5. Wait about a minute. Your app's address appears at the top of that page, for example `https://your-name.github.io/yomu/`.

## 2. Add it to your iPhone home screen

1. Open the address in **Safari**.
2. Tap the Share button, then **Add to Home Screen**.
3. Open Yomu from the home screen from now on. This matters: iOS keeps the books of home-screen apps much more reliably than those of regular Safari tabs.

## 3. Connect jpdb

1. On jpdb.io, open Settings and scroll to the bottom to copy your API key.
2. In Yomu, tap **Settings**, paste the key, and tap **Check key**.
3. Choose the deck where new words should go.

## 4. Add books

1. Save your EPUB files to iCloud Drive (or anywhere in the Files app).
2. In Yomu, tap **Add book** and pick a file.

Keep the original files in iCloud Drive. The copy inside Yomu is for reading, not a backup.

## Using it

- **Tap a word** to see its reading, meanings, and the sentence it's in.
- **Add to deck** adds it to your chosen deck, with the sentence attached (you can turn that off in Settings).
- **I know this** marks it as known on jpdb, so it stops showing readings.
- **Turn pages** by tapping the left or right side of the screen, or swiping. Vertical books read right to left, like a printed Japanese book: tap the left side or swipe right for the next page. Horizontal books are the other way round.
- **Tap the middle** of the page to hide or show the top bar.
- **Settings → Show readings over** chooses whether readings appear over all words, only words you don't know yet, or none.
- **Settings → Appearance** switches between light, dark, or matching your phone. **Typeface** switches between Mincho (the usual book style) and Gothic.
- You can turn on underlines in Settings: words not in any of your decks get a dotted underline, and words you're learning a thin solid one. They're off by default to keep the page clean.
- Readings the book itself prints are always kept, since they come from the author. So are its emphasis dots, upright numbers, bold text, indents and headings.

## Good to know

- Readings need an internet connection. Without one, the book still opens, just without readings.
- Books with copy protection (for example, Kindle books) can't be opened. Yomu tells you when this is the case.
- Manga and other books made only of page images show the images but no readings, because there's no text to read.

## Updating the app

When you get new versions of the files, upload them to the same GitHub repository (Add file → Upload files) and commit. The app picks up the change the next time you open it with an internet connection. Your books and settings stay as they are.
