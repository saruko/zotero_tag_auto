# EyeWiki RAG Chatbot (Gemini / Colab)

This repo provides a Google Colab-ready notebook that builds a Japanese ophthalmology education chatbot for medical students. The bot scrapes EyeWiki pages, builds a lightweight RAG index, and answers in Japanese with Gemini API.

## Quick start (Colab)
1. Open `colab/eyewiki_gemini_rag.ipynb` in Google Colab.
2. Add your `GOOGLE_API_KEY` when prompted.
3. Run all cells and ask ophthalmology questions in Japanese.

## Notes
- EyeWiki is scraped at runtime; you can change the maximum number of pages and delay between requests in the notebook.
- The notebook includes URLs of retrieved sources in the response for transparency.
