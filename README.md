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

- **Tap a word** to see its reading, meanings, and the sentence it's in. A line under the word says how common it is (Very common, Common, Less common, Uncommon or Rare), from jpdb's ranking of the words most used in Japanese media, so you can decide whether it's worth adding to a deck.
- **Add to deck** adds it to your chosen deck, with the sentence attached (you can turn that off in Settings).
- **Explain a sentence:** select any text in the book and tap **Explain**, or tap a word and choose **Explain this sentence**. You get an English translation, a word-for-word version when it helps, and the grammar points worth knowing, each with its reading. This uses the Gemini key on the Vercel relay and needs an internet connection.
- **Review words** after reading, or in the middle of a chapter: the cap button in the reading bar shows how many words are waiting, and when 20 are waiting Yomu offers a short review at the bottom of the page (it goes away when you turn the page). A session has at most 20 cards, starting with the words you tapped most and the most common ones; the rest wait for the next session. Each word appears once, and every card says what your grade does: **New on jpdb** (words you added: your grade starts them on jpdb), **Review on jpdb** (words you'd studied but looked up: your grade counts as a jpdb review, and the sentence is saved on the card), or **Practice only** (words outside your decks: nothing goes to jpdb, and **Add to my deck** adds one). Practice-only words join a session only if you tapped them twice or they're common, since most of the others are names or rare words. Words you forget on jpdb come back once at the end, in a short round called **One more time**. jpdb locks some words until you've learned their kanji; Yomu lists those with a link to each word's page on jpdb.io.
- **Write about the chapter:** at the end of each chapter, **Write about this chapter** asks you a short question about what you just read, in simple Japanese with an English translation under it, and suggests a few of the words you tapped in that chapter (tap one to put it in your text). Write a line or two and tap **Check**: you get a more natural version with the changes underlined, a short note on the main fix, and an English translation. Everything you write is kept: tap the button again to see it, or open **Contents → Your writing** for the whole book. **Different question** asks something else. Stuck? **Help me say it** opens a short chat: say what you want to write, in English or a mix, and you get a simple way to say it in Japanese, with the harder words' readings and a short explanation. **Add to my text** puts it in your draft. After a check, **Help me say what I meant** starts a new version from the corrected text with the chat open. Your questions are kept with the entry. **Skip this chapter** closes it; **Just reading this book** turns writing off for that book (turn it back on from Contents), and **Settings → Write a line at the end of each chapter** turns it off everywhere. Questions and corrections use the Gemini key on the Vercel relay; what you write is kept on your phone.
- **I know this** marks it as known on jpdb, so it stops showing readings.
- **The library** shows the time and date, today's reading time and how many words are waiting, then a large card for the book you're reading with **continue**. **Settings → Library background** picks the picture behind it (or none); in light mode the picture is shown inverted.
- **Turn pages** by tapping the left or right side of the screen, or swiping. Vertical books read right to left, like a printed Japanese book: tap the left side or swipe right for the next page. Horizontal books are the other way round.
- **Tap the middle** of the page to hide or show the top bar.
- **Settings → Show readings over** chooses whether readings appear over all words, only words you don't know yet, or none.
- **Settings → Appearance** switches between light, dark, or matching your phone. **Typeface** switches between Mincho (the usual book style) and Gothic.
- You can turn on underlines in Settings: words not in any of your decks get a dotted underline, and words you're learning a thin solid one. They're off by default to keep the page clean.
- Readings the book itself prints are always kept, since they come from the author. So are its emphasis dots, upright numbers, bold text, indents and headings.

## Discover

Switch from **Library** to **Discover** at the top of the first screen to find free books from Aozora Bunko (青空文庫).

- **Shelves** for Easy, Intermediate and Advanced, plus the books most read on Aozora.
- **Search** all of Aozora by title or author, in kanji, kana or romaji, or by English title.
- **Filters:** "Modern spelling" (on by default) hides books written in pre-war spelling, which is much harder to read. You can also filter by length.
- **Tap a book** to see its English title, a short plot summary in English (for about 380 of the most-read works), the opening lines, and how many of its words you already know on jpdb. Then add it to your library in one tap.
- Reading times use your own reading speed, so they get more accurate as you read.

## Web novels

Discover has two parts: **Classics** (Aozora Bunko) and **Web novels**, from Kakuyomu (カクヨム) and Narou (小説家になろう), two free sites where people publish modern novels.

- **Pick a mood, a genre, or both.** Moods come from the tags authors put on their stories: Gentle, Funny, Moving, Gripping. "Gentle + Sci-fi" finds soft sci-fi; "Funny + Fantasy" finds comedic fantasy.
- **Easiest for you first.** Yomu checks each story's first episode against your jpdb words and shows how many you already know: Comfortable (90% or more), A stretch (80–89%), or Hard. Scores are rechecked every two weeks, as your decks grow.
- **For you** recommends stories from three things together: how easy each is for you, how well it matches what you like, and how much other readers like it. What you like is learned from the stories you save (counts most), add to your library (counts most), and the moods and genres you browse. Each pick says which of your interests it matches.
- **Saved:** tap the bookmark on any story, or **Save for later** on its details page, to keep it in the Saved list. Saved stories stay on this phone.
- **Reader signals:** each card shows how much readers like the story (Loved by many, Popular, Liked, Some readers, Few readers yet), and the details page shows ratings, followers and translated reader reviews.
- **English:** with a Gemini key on the Vercel relay, cards show an English title and one-line description, and the details page an English summary.
- **Add a story** from its details. To check a story you found elsewhere, paste its link (or a Kakuyomu search link, or just type its title) under **Add book → Web novel** and tap **Look up**: you get the same details page (difficulty, English summary, what readers say), with Add to library and Save for later. Yomu downloads the first 10 episodes, then more whenever you reach the end.
- Episodes are downloaded slowly, one at a time, and kept only on your phone, for your own reading. Nothing is saved to GitHub.
- The authors' own readings and emphasis dots are kept.
- Neither site lets other websites read its pages, so Yomu goes through a small relay: `serve.py` on the Mac, or a free Cloudflare Worker online (see `relay/README.md`).

## Testing on the Mac

In Terminal, from the yomu folder, run `python3 serve.py`, then open the address it prints on your iPhone (same Wi-Fi).

## Progress

The bottom of each page shows how far you are through the whole book and roughly how many minutes are left in the chapter. The time adjusts to how fast you actually read.

## Reading offline

- **Chapters you open are saved automatically.** Their readings and meanings show straight away next time, even without internet.
- **Save a whole book** from **Contents → Offline reading → Save book**. It takes a minute or two for a novel, and you can keep reading meanwhile.
- **Words you add while offline** wait on the phone and go to your jpdb deck as soon as you're back online.
- **Offline dictionary** (Settings, about 25 MB): for pages that were never saved, Yomu can use a dictionary on the phone instead of jpdb. Its readings are less accurate than jpdb's, so it's only used when jpdb can't be reached.

## Same place on every device

In **Settings → Sync between devices**, follow the link to create a key on GitHub (keep only "gist" ticked, choose "No expiration"), paste it, and tap **Connect**. Do the same on each device. Your place in each book is then kept in a private note on your GitHub account, and Yomu picks up where you left off when you open a book or come back to the app. Only positions are stored, never books.

## Good to know

- Books with copy protection (for example, Kindle books) can't be opened. Yomu tells you when this is the case.
- Manga and other books made only of page images show the images but no readings, because there's no text to read.

## Updating the app

Claude saves changes straight to this GitHub repository. The app picks them up the next time you open it with an internet connection. If a change doesn't show, close the app fully and open it again. Your books and settings stay as they are.

## Credits

Dictionary data from JMdict by the Electronic Dictionary Research and Development Group (CC BY-SA 4.0). Word splitting by kuromoji.js with the IPADIC dictionary (Apache 2.0). Readings and decks by jpdb.io. Books from Aozora Bunko, fetched through the aozorahack copy on GitHub. Web novels from Kakuyomu and Narou belong to their authors.
