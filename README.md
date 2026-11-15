# Document Desk

Document Desk uses Gemini or offline search to find and cite exact passages from your documents.

## Run it

1. Install Node.js 22.13 or newer.
2. Run `pnpm install` and then `pnpm start` from this folder. With npm, use `npm install` and `npm start`.
3. Open [Document Desk](http://127.0.0.1:3000).
4. Upload one or more PDF (`.pdf`), Word (`.docx`, `.doc`), UTF-8 Markdown (`.md`, `.markdown`), or plain-text (`.txt`) files. Use **Search in** to ask about one document or the whole library.

The app converts PDF and Word files to Markdown locally during upload. PDF conversion extracts selectable text with page headings. Scan-only PDFs need OCR first, and password-protected PDFs need to be unlocked. Word conversion extracts text and preserves supported headings, lists, and tables from DOCX files.

On Windows, the app stores its library at `%LOCALAPPDATA%\Document Desk\documents.md`. On other systems it uses `$XDG_DATA_HOME/Document Desk/documents.md` or `~/.local/share/Document Desk/documents.md`. To migrate a library from an earlier version, copy the old `data/documents.md` to that location before the first upload. Keep the section markers intact. Each upload supports up to 10 MB and 200,000 converted characters. The library holds up to 100 documents and 700,000 characters in total.

The server listens on loopback. **Gemini** mode uses the key in the local, Git-ignored `.env` file as `GEMINI_API_KEY`. When you ask a question, it sends the question and the selected document text to Google's Gemini API. It verifies the returned excerpts before displaying them. **Offline** mode searches the library on your computer using keyword matching. Each result is a verbatim excerpt from the library.

Document questions search your uploaded documents by default. To browse the web, open **Search the web**, enter a separate query, and click **Search DuckDuckGo**. The browser opens DuckDuckGo results in a new tab and submits only that query. Uploaded files, document excerpts, and chat messages stay out of the search request. To use a file you find in a document answer, download it and upload it to Document Desk.

Each question is evaluated independently against the selected documents. Include the relevant subject when asking a follow-up.

## Deploy on Vercel

1. Import this repository into Vercel and use the Node.js server entry point, `server.mjs`. Keep Vercel system environment variables exposed so the app can detect the deployment.
2. Create a **private** Vercel Blob store and connect it to the project with a read-write token. Verify that `BLOB_READ_WRITE_TOKEN` is available in the environment you deploy.
3. Set `DOCUMENT_DESK_PASSWORD` to a strong password and `GEMINI_API_KEY` to your Gemini key in the project environment variables. Redeploy after setting them.
4. Open the deployed URL. Sign in with username `document-desk` and the password you configured.

The hosted app keeps its shared Markdown library in private Blob storage. Anyone with the app password can access that library. Hosted uploads are limited to 4 MB per file, and **Server search** searches the hosted library without calling Gemini. To bring documents from your local library into Vercel, upload them from the deployed app.
