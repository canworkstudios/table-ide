# Table IDE — Table Formatter and Node Editor

**Browser-native table editor for engineers, developers, and data analysts.**  
Parse, reshape, and export structured table data, PDF tables, scraped HTML, legacy exports, and more without installing anything.  
Part of the [Ginexys](https://ginexys.com) engineering pipeline.

## Table of Contents
- [What it does](#what-it-does)
- [Documentation](#-documentation)
- [Input formats](#input-formats)
- [Export formats](#export-formats)
- [Key features](#key-features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Quick start](#quick-start)
- [Who uses this](#who-uses-this)
- [Part of the Ginexys pipeline](#part-of-the-ginexys-pipeline)
- [Built with](#built-with)
- [Self-hosting](#self-hosting)
- [Open source](#open-source)
- [Contributing](#contributing)
- [License](#license)

---

![Table IDE Table Formatter demo](./table-ide-demo.gif)
Try it now -> [Table IDE](https://ginexys.com/tools/table-formatter/index.html)
## What it does

You got a table from a PDF scrape, a legacy export, 
or a broken copy-paste. It's mangled.

Table IDE parses it into a live visual editor. Reshape it 
visually — drag columns, merge cells, split text, transpose. 
Then generate clean code into a Monaco editor instance where 
you can refine it directly before copying. HTML, Markdown, 
JSON, CSV, or SQL INSERT statements.

---

## 📚 Documentation

**[→ Open the tool](https://ginexys.com/tools/table-formatter/index.html)** · **[→ Getting Started](https://ginexys.com/table-formatter/docs/getting-started.html)**

Detailed guides are available to help you get the most out of Table IDE:

*   **[Getting Started](docs/getting-started.md)**: A user-centric guide to importing data, basic editing, and the interface.
*   **[Operation Modes](docs/modes.md)**: Explore the visual grid, Draw Mode, and the Node Editor pipeline.
*   **[Styles and IDs](docs/styles-and-id.md)**: Guide to applying CSS classes, visual styles, and built-in interactive utilities.
*   **[Functions and Operations](docs/functions.md)**: Technical reference for structure manipulation, transformations, and exports.
*   **[Node Editor Engine](docs/node-editor-engine.md)**: Advanced documentation for the visual execution engine.

---

## Input formats

| Format | Example source |
|---|---|
| HTML | Scraped web tables, legacy CMS exports |
| CSV / Spreadsheet | Excel, Google Sheets, instrument exports |
| ASCII | Terminal output, scientific software, legacy systems |
| Plain text | Anything tab or pipe delimited |

---

## Export formats

| Format | Use case |
|---|---|
| **HTML** | Documentation, web publishing, Confluence |
| **Markdown** | GitHub docs, Notion, GitBook, Docusaurus |
| **CSV** | Data pipelines, Excel re-import |
| **JSON** | API payloads, config files, test fixtures |
| **SQL** | Database seed files, migration scripts — `INSERT INTO` ready |

> **SQL export** is the differentiator. Paste a CSV, get INSERT statements. Most table tools don't do this.

---

## Key features

- **Multi-format paste** — HTML, CSV, ASCII, or text. One input panel, auto-detected.
- **Visual drag-and-drop** — reorder rows and columns by dragging, no code editing
- **Cell merging** — colspan and rowspan via toolbar or keyboard shortcut
- **Text split** — split a cell's content into rows or columns using custom delimiters
- **Transpose** — flip rows and columns in one click
- **Node editor** — build tables from scratch using a visual node graph
- **Draw mode** — mark raw pasted data as header / column / row regions
- **Multi-select** — Ctrl/Cmd+click, range drag, or Shift+click for bulk operations
- **Full keyboard shortcuts** — see [shortcuts reference](https://ginexys.com/table-formatter/docs/getting-started.html)
- **Undo / Redo** — full history stack
- **Built-in CSS classes** — accordion rows, freeze panes, column toggles, mobile styles
- **Zero dependencies on your end** — runs entirely in the browser

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Insert` | Insert cell |
| `Delete` | Delete cell |
| `Alt+Shift+W` | Merge cells |
| `Alt+Shift+T` | Text split |
| `Alt+Shift+X` | Apply text split |
| `Ctrl/Cmd+click` | Multi-select cells |
| `Shift+click` | Range select |
| `Double-click` | Edit cell content |

---

## Quick start

1. Open **[the tool](https://ginexys.com/tools/table-formatter/index.html)**
2. Click **Load Sheet** and paste your data (CSV, HTML, ASCII, or text)
3. Edit visually — drag, merge, split, transpose
4. Click **Generate Code**, choose your format, copy or download
5. Done.

Full walkthrough: **[Getting Started →](https://ginexys.com/table-formatter/docs/getting-started.html)**

---

## Who uses this

**Technical writers** — clean HTML or Markdown tables for docs platforms (Confluence, GitBook, Docusaurus)  
**Backend developers** — SQL INSERT statements from CSV exports, no scripting required  
**Data analysts** — reshape legacy CSV/ASCII exports from ERP systems, lab instruments  
**Researchers** — reformat ASCII tables from scientific software for LaTeX or Python import  
**No-code builders** — complex HTML tables with colspan, rowspan, and accordion rows for Webflow / CMS

---

## Part of the Ginexys pipeline

Table IDE is the **Transform** step of the Ginexys engineering document pipeline:

```
Extract (PDF/image → structured data)  ←  AI layer · in development
    ↓
Transform (reshape, edit, clean)        ←  Table IDE · live now
    ↓
Engineer (schematic / topology editor)  ←  in development
```

The extraction and schematic engines are in active development.  
Follow this repo or **[join the community](https://ginexys.com)** to track progress.

---

## Built with

- Vanilla JavaScript
- jQuery
- HTML / CSS
- Zero build step — open `index.html` and it runs

Deliberately framework-free. The core engine ships as a single file, self-hostable, embeddable anywhere.

---

## Self-hosting

```bash
git clone https://github.com/canworkstudios/table-ide
cd Table IDE
# Open index.html in any browser. No server required.
```

---

## Open source

MIT licensed. Core engine is free forever.  
The AI extraction layer (PDF → structured data → Table IDE) is the commercial product.  
[Sponsor on GitHub](https://github.com/canworkstudios) to support development.

---

## Contributing

Good first issues are labeled **`good first issue`** in the issues tab.  
Suggestions, bug reports, and feature requests welcome via [GitHub Issues](https://github.com/canworkstudios/Table IDE/issues).  
Design discussions in [GitHub Discussions](https://github.com/canworkstudios/Table IDE/discussions).

---

## License

MIT · © 2025 [Ginexys / Canworks LLC](https://ginexys.com)