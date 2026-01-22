# Knowledge Graph Visualization

This repository contains an interactive Knowledge Graph visualization built with **D3.js**. It maps complex relationships between political debates, public opinions, and arguments, allowing users to explore the data through a timeline, depth levels, and an interactive force-directed graph.

## 📂 Project Structure

The project follows a modular architecture to separate logic, styling, and data:

```text
.
├── css/
│   └── style.css          # Styles for the UI, sidebar, and graph elements
├── data/
│   ├── authors.json       # Metadata regarding the authors/users
│   ├── tutorial.json      # Configuration file for the interactive tutorial steps
│   ├── KG_nodes.csv       # Graph nodes (manually exported)
│   └── KG_edges.csv       # Graph edges (manually exported)
├── js/
│   └── script.js          # Main logic: D3.js simulation, timeline, and UI handlers
├── index.html             # Main entry point
└── README.md              # Documentation