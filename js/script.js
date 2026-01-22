// --- SETUP INIZIALE ---
const svg = d3.select("#graph");
let width = document.getElementById("graph-container").clientWidth;
let height = document.getElementById("graph-container").clientHeight;
let simulation = null;

const tooltip = d3.select("#tooltip");

let interactive = false;
let currentDepthLevel = 3; // Start at max depth
let revealedNodes = new Set(); // Track manually expanded nodes
let authorMap = new Map(); // To cache author details
let tutorialSteps = [];
let updateMinimapViewport = null; // Funzione placeholder per aggiornare la minimappa

// Group wrapper for zoom/pan
const g = svg.append("g");

// Drawing Order: Hulls -> Links -> Nodes -> Labels
const hullGroup = g.append("g").attr("class", "hulls");
const linkGroup = g.append("g").attr("class", "links");
const nodeGroup = g.append("g").attr("class", "nodes");
const labelGroup = g.append("g").attr("class", "labels");

const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .on("zoom", (event) => {
        if (!interactive) return;
        g.attr("transform", event.transform);
        if (updateMinimapViewport) updateMinimapViewport(event.transform);
    });

svg.call(zoom);

window.addEventListener("resize", () => {
    const container = document.getElementById("graph-container");
    if (!container) return;

    width = container.clientWidth;
    height = container.clientHeight;

    // Controllo di sicurezza: esegui solo se la simulazione è già stata inizializzata
    if (simulation) {
        const tutorialSidebar = document.getElementById("tutorial-sidebar");
        const tutorialOpen = tutorialSidebar && !tutorialSidebar.classList.contains('tutorial-closed');
        updateSimulationCenter(tutorialOpen);
    }
});

function hexToRgba(hex, alpha) {
    hex = hex.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// --- GLOBAL REFERENCES ---
let globalNodes = [];
let globalEdges = [];
let titleAccessorGlobal;
let globalClusterMembers = new Map();
// --- TIMELINE VARIABLES (GLOBAL) ---
let timeDomain = [0, 0];
let currentTime = 0;
let isPlaying = false;
let playInterval;
const animationDuration = 10000;
let isTimelineUpdate = false;

// Placeholder per updateGraphDepth (verrà sovrascritta dopo il caricamento dati)
window.updateGraphDepth = function() {};

let selectedNodeData = null;
let selectionRing;

// --- HIGHLIGHT FUNCTIONS ---
function highlightNodes(filterFn) {
    // 1. Update NODI
    nodeGroup.selectAll("path").transition().duration(400)
        .attr("fill-opacity", d => (filterFn(d) ? 1 : 0.15))
        .attr("stroke-opacity", d => (filterFn(d) ? 1 : 0.1));

    // 2. Update LINK (La logica richiesta)
    linkGroup.selectAll("line").transition().duration(400)
        .attr("stroke", "#bbb") // Assicura che il colore sia sempre quello corretto
        .attr("stroke-opacity", d => {
            // Un link è attivo SOLO SE entrambi i nodi che connette sono attivi
            const isSourceActive = filterFn(d.source);
            const isTargetActive = filterFn(d.target);

            if (isSourceActive && isTargetActive) {
                // Se attivo, manteniamo la distinzione semantica AI (ENTITY) vs Umano
                const sType = titleAccessorGlobal(d.source);
                const tType = titleAccessorGlobal(d.target);
                return (sType === "ENTITY" || tType === "ENTITY") ? 0.4 : 0.8;
            }

            // Se uno dei due nodi è disattivo, il link quasi scompare
            return 0.02;
        });

    // 3. Update ETICHETTE
    labelGroup.selectAll("text").transition().duration(400)
        .attr("opacity", d => (filterFn(d) ? 1 : 0.1));

    // 4. Update HULLS (Aree Cluster)
    hullGroup.selectAll("path").transition().duration(400)
        .attr("fill-opacity", d => (filterFn(d) ? 0.5 : 0.1))
        .attr("stroke-opacity", d => (filterFn(d) ? 1.0 : 0.2));
}

function resetHighlight() {
    nodeGroup.selectAll("path").transition().duration(400)
        .attr("fill-opacity", 1)
        .attr("stroke-opacity", 1);

    linkGroup.selectAll("line").transition().duration(400)
        .attr("stroke", "#bbb") // Uniforma il colore al reset
        .attr("stroke-opacity", d => {
            const sType = titleAccessorGlobal(d.source);
            const tType = titleAccessorGlobal(d.target);
            // Torna all'opacità di default: 0.25 per AI, 0.6 per Umano
            return (sType === "ENTITY" || tType === "ENTITY") ? 0.25 : 0.6;
        });

    labelGroup.selectAll("text").transition().duration(400)
        .attr("opacity", 1);

    hullGroup.selectAll("path").transition().duration(400)
        .attr("fill-opacity", 0.25)
        .attr("stroke-opacity", 0.75);
}

Promise.all([
    d3.csv("data/KG_nodes.csv"),
    d3.csv("data/KG_edges.csv"),
    d3.json("data/authors.json").catch(err => {
        console.warn("File authors.json not found", err);
        return [];
    }),
    d3.json("data/tutorial.json").catch(err => {
        console.error("Errore caricamento tutorial.json:", err);
        return [];
    })
]).then(([nodes, edges, authorsData, tutorialData]) => {

    // Inizializza l'anello di selezione
    selectionRing = nodeGroup.append("circle").attr("class", "selection-ring").style("opacity", 0);

    if (Array.isArray(tutorialData) && tutorialData.length > 0) {
        tutorialSteps = tutorialData;
    } else {
        console.warn("Tutorial data vuoto o non valido.");
    }

    // --- Creazione Mappa Autori ---
    // Usiamo la variabile globale authorMap definita sopra
    if (Array.isArray(authorsData)) {
        authorsData.forEach(user => {
            // Mappa ID -> Nome
            // Le API BCause usano solitamente 'name' o 'nickname'
            const cleanId = String(user.id).replace(/['"]+/g, '').trim();
            const name = user.pseudo || "Anonymous";
            authorMap.set(cleanId, name);
        });
    }
    // -----------------------------

    // --- TIMELINE LOGIC: Mappatura Timestamp ---
    // (timeDomain, currentTime, isPlaying, playInterval, animationDuration già definiti come globali)
    const nodeTimeMap = new Map(); // ID Autore -> Timestamp

    if (Array.isArray(authorsData)) {
        authorsData.forEach(item => {
            // Mappa Timestamp usando ID dell'autore (item.id)
            if (item.id && item.creation_timestamp) {
                nodeTimeMap.set(item.id, item.creation_timestamp);
            }
        });
    }

    // Assegna timestamp ai nodi usando detail__author_id
    let minTs = Infinity;
    let maxTs = -Infinity;

    nodes.slice(0, 5).forEach(n => {
        let cleanAuthorId = n.detail__author_id ? n.detail__author_id.replace(/"/g, '') : null;
        console.log(`  Nodo ${n.id}: detail__author_id="${cleanAuthorId}", hasTimestamp=${nodeTimeMap.has(cleanAuthorId)}`);
    });

    nodes.forEach(n => {
        // Usa detail__author_id (colonna che contiene l'ID autore del contributo)
        // Rimuovi le virgolette extra dal CSV
        let authorId = n.detail__author_id ? n.detail__author_id.replace(/"/g, '') : null;

        if (authorId && nodeTimeMap.has(authorId)) {
            n.timestamp = nodeTimeMap.get(authorId);
        } else {
            n.timestamp = null; // Da calcolare dopo (propagazione)
        }
    });

    // Propagazione date: Un nodo senza data nasce quando nasce il suo primo vicino
    // Eseguiamo 3 iterazioni per propagare attraverso la rete
    for (let i = 0; i < 3; i++) {
        nodes.forEach(n => {
            if (n.timestamp) return; // Salta se ha già data

            // Trova vicini tramite edges
            const neighborIds = new Set();
            edges.forEach(e => {
                if (e.source === n.id) neighborIds.add(e.target);
                if (e.target === n.id) neighborIds.add(e.source);
            });

            // Trova data minima tra i vicini
            let earliest = Infinity;
            nodes.forEach(neighbor => {
                if (neighborIds.has(neighbor.id) && neighbor.timestamp) {
                    if (neighbor.timestamp < earliest) earliest = neighbor.timestamp;
                }
            });

            if (earliest !== Infinity) n.timestamp = earliest;
        });
    }

    // Calcola dominio temporale
    nodes.filter(n => n.timestamp).forEach(n => {
        if (n.timestamp < minTs) minTs = n.timestamp;
        if (n.timestamp > maxTs) maxTs = n.timestamp;
    });

    // Fix finale: assegna minTs a chi è rimasto senza data
    nodes.forEach(n => {
        if (!n.timestamp) n.timestamp = minTs === Infinity ? 0 : minTs;
    });

    // Imposta dominio e tempo iniziale
    timeDomain = [minTs === Infinity ? 0 : minTs, maxTs === -Infinity ? 0 : maxTs];
    currentTime = timeDomain[1]; // Inizia alla fine (tutto visibile)

    titleAccessorGlobal = d => d.title || d.detail__title || "Untitled";
    const titleAccessor = titleAccessorGlobal;

    globalNodes = nodes;
    globalEdges = edges;

    const uniqueEdgesMap = new Map();
    edges.forEach(e => {
        const key = `${e.source}-${e.target}-${e.mainStat}`;
        if (!uniqueEdgesMap.has(key)) {
            uniqueEdgesMap.set(key, e);
        }
    });
    const cleanedEdges = Array.from(uniqueEdgesMap.values());

    // Aggiorna riferimento globale
    globalEdges = cleanedEdges;

    // Network Palette
    const colorMap = {
        "SUBJECT": "#3f88c5",
        "POSITION": "#F49D37",
        "INFAVOR": "#00cc66",
        "AGAINST": "#db3a34",
        "ENTITY": "#b38cb4",
        "ARGUMENT": "#e377c2",
        "default": "#7f7f7f"
    };

    const clusterFillColor = "#e2e8f0"; // Grigio chiaro azzurrato
    const clusterStrokeColor = "#94a3b8"; // Bordo più scuro coordinato

    function getClusterColor(d) {
        const members = globalClusterMembers.get(d.id) || [];
        let inFavor = 0;
        let against = 0;

        members.forEach(m => {
            const type = titleAccessorGlobal(m);
            if (type === "INFAVOR") inFavor++;
            if (type === "AGAINST") against++;
        });

        if (inFavor > against) {
            return { fill: "#dcfce7", stroke: "#86efac" }; // Verde tenue
        } else if (against > inFavor) {
            return { fill: "#fee2e2", stroke: "#fca5a5" }; // Rosso tenue
        }
        return { fill: clusterFillColor, stroke: clusterStrokeColor };
    }

    function getNodeColorByType(type) {
        return colorMap[type] || colorMap["default"];
    }

    function getNodeColor(d) {
        return getNodeColorByType(titleAccessor(d));
    }

    function getShapeByType(type) {
        return type === "ENTITY" ? "diamond" : "circle";
    }

    const nodeById = new Map(nodes.map(d => [d.id, d]));
    edges = edges.filter(e => nodeById.has(e.source) && nodeById.has(e.target));

    // --- CLUSTER LOGIC ---
    const clusterMembers = new Map();

    nodes.forEach(n => {
        if (titleAccessor(n) === "CLUSTER") {
            clusterMembers.set(n.id, [n]);
        }
    });

    edges.forEach(e => {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        const sType = titleAccessor(s);
        const tType = titleAccessor(t);

        if (sType === "CLUSTER") {
            if (clusterMembers.has(s.id)) clusterMembers.get(s.id).push(t);
        }
        if (tType === "CLUSTER") {
            if (clusterMembers.has(t.id)) clusterMembers.get(t.id).push(s);
        }
    });

    globalClusterMembers = clusterMembers;

    const structuralDegree = new Map(); // Solo connessioni tra contributi umani
    const conceptualDegree = new Map(); // Connessioni verso le keyword

    nodes.forEach(n => {
        structuralDegree.set(n.id, 0);
        conceptualDegree.set(n.id, 0);
    });

    cleanedEdges.forEach(e => {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        const sType = titleAccessorGlobal(s);
        const tType = titleAccessorGlobal(t);

        // Se nessuno dei due è una Keyword, è un legame strutturale (umano)
        if (sType !== "ENTITY" && tType !== "ENTITY") {
            structuralDegree.set(e.source, structuralDegree.get(e.source) + 1);
            structuralDegree.set(e.target, structuralDegree.get(e.target) + 1);
        } else {
            // Altrimenti è un legame concettuale
            conceptualDegree.set(e.source, conceptualDegree.get(e.source) + 1);
            conceptualDegree.set(e.target, conceptualDegree.get(e.target) + 1);
        }
    });

    const nodeToClusterMap = new Map();
globalClusterMembers.forEach((members, clusterId) => {
    members.forEach(m => {
        if (titleAccessorGlobal(m) !== "CLUSTER") {
            nodeToClusterMap.set(m.id, clusterId);
        }
    });
});

    nodes.forEach(n => {
        const type = titleAccessorGlobal(n);
        if (type === "ENTITY") {
            // Le keyword si basano sul loro grado concettuale
            n.degree = conceptualDegree.get(n.id);
        } else {
            // I contributi umani ignorano le keyword per la loro dimensione
            n.degree = structuralDegree.get(n.id);
        }
    });

    // Scale diverse per pesi diversi
    const sizeScale = d3.scaleLinear()
        .domain([0, d3.max(nodes.filter(n => titleAccessorGlobal(n) !== "ENTITY"), d => d.degree)])
        .range([12, 45]); // Nodi umani: da 12 a 45px

    const keywordScale = d3.scaleLinear()
        .domain([0, d3.max(nodes.filter(n => titleAccessorGlobal(n) === "ENTITY"), d => d.degree)])
        .range([2, 8]);  // Keyword: molto più piccole e discrete (6-12px)

    function getNodeVisualRadius(d) {
        const type = titleAccessorGlobal(d);
        if (type === "ENTITY") return keywordScale(d.degree || 0);
        if (type === "SUBJECT") return 50; // Il soggetto è sempre il più grande

        if (type === "POSITION") {
            // Enfatizza la dimensione dei nodi POSITION in base alle connessioni
            // Base 16px + 3.5px per ogni connessione, max 48px
            const deg = d.degree || 0;
            return Math.min(8 + (deg * 3.5), 48);
        }

        return sizeScale(d.degree || 0);
    }

    // --- EVENT HANDLERS DEFINITIONS ---
    function handleNodeMouseOver(event, d) {
        if (!interactive) return;
        tooltip.style("opacity", 1).html(buildTooltipHTML(d));
        moveTooltip(event);

        if (titleAccessorGlobal(d) === "ENTITY" && d.detail__value && !d._open) {
            const nodeSel = d3.select(event.currentTarget);
            nodeSel.attr("opacity", 0);

            const hoverLabel = labelGroup.append("text")
                .datum(d)
                .attr("class", "entity-hover-label")
                .attr("text-anchor", "middle")
                .attr("alignment-baseline", "middle")
                .style("font-size", "11px")
                .style("font-weight", "500")
                .style("pointer-events", "none")
                .text(truncate(d.detail__value, 24));

            hoverLabel
                .attr("x", d.x)
                .attr("y", d.y);
        }
    }

    function handleNodeMouseMove(event) {
        if (!interactive) return;
        moveTooltip(event);
    }

    function handleNodeMouseOut(event, d) {
        if (!interactive) return;
        tooltip.style("opacity", 0);

        if (titleAccessorGlobal(d) === "ENTITY" && d.detail__value) {
            const nodeSel = d3.select(event.currentTarget);
            nodeSel.attr("opacity", 1);
            labelGroup.selectAll(".entity-hover-label")
                .filter(l => l.id === d.id)
                .remove();
        }
    }

    function handleNodeClick(event, d) {
        if (!interactive) return;
        event.stopPropagation();

        // Gestione selezione visiva (Highlight click)
        nodeGroup.selectAll(".node").classed("selected", false);
        d3.select(event.currentTarget).classed("selected", true).raise();

        // Gestione Anello Tecnico
        selectedNodeData = d;
        selectionRing.attr("r", getNodeVisualRadius(d) + 5).style("opacity", 1).raise();

        resetEntitiesVisuals();
        showNodeDetails(d);

        let isOpening = true;

        // --- LOGICA TOGGLE / DRILL-DOWN ---
        if (currentDepthLevel < 3) {
            const type = titleAccessorGlobal(d);
            let directChildren = [];
            let subChildren = [];

            if (currentDepthLevel === 1 && type === 'POSITION') {
                directChildren = globalEdges.filter(e => (e.source.id || e.source) === d.id || (e.target.id || e.target) === d.id)
                    .map(e => (e.source.id || e.source) === d.id ? e.target : e.source)
                    .filter(n => {
                        const t = titleAccessorGlobal(n);
                        return t === 'INFAVOR' || t === 'AGAINST';
                    });

                directChildren.forEach(arg => {
                    const entities = globalEdges.filter(e => (e.source.id || e.source) === arg.id || (e.target.id || e.target) === arg.id)
                        .map(e => (e.source.id || e.source) === arg.id ? e.target : e.source)
                        .filter(n => titleAccessorGlobal(n) === 'ENTITY');
                    subChildren.push(...entities);
                });
            }

            else if ((currentDepthLevel < 3) && (type === 'INFAVOR' || type === 'AGAINST')) {
                directChildren = globalEdges.filter(e => (e.source.id || e.source) === d.id || (e.target.id || e.target) === d.id)
                    .map(e => (e.source.id || e.source) === d.id ? e.target : e.source)
                    .filter(n => titleAccessorGlobal(n) === 'ENTITY');
            }

            if (directChildren.length > 0) {
                const isBranchOpen = directChildren.some(child => revealedNodes.has(child.id));

                if (isBranchOpen) {
                    isOpening = false;
                    directChildren.forEach(n => revealedNodes.delete(n.id));
                    subChildren.forEach(n => revealedNodes.delete(n.id));
                } else {
                    isOpening = true;
                    directChildren.forEach(n => revealedNodes.add(n.id));
                }

                updateGraphDepth(currentDepthLevel, true);
            }
        }

        const t = titleAccessorGlobal(d);
        if ((t === "INFAVOR" || t === "AGAINST") && isOpening) {
            showConnectedEntitiesText(d);
        }

        highlightNodes(n =>
            n.id === d.id ||
            globalEdges.some(e => ((e.source.id || e.source) === d.id && (e.target.id || e.target) === n.id) || ((e.target.id || e.target) === d.id && (e.source.id || e.source) === n.id))
        );
    }

    function handleHullClick(event, d) {
        if (!interactive) return;
        event.stopPropagation();
        resetEntitiesVisuals();
        showNodeDetails(d);

        const members = globalClusterMembers.get(d.id) || [];
        const memberIds = new Set(members.map(m => m.id));
        highlightNodes(n => memberIds.has(n.id));
    }

    function handleHullMouseOver(event, d) {
        if (!interactive) return;
        tooltip.style("opacity", 1).html(`<strong>CLUSTER</strong><br/>${d.detail__tagline || ""}`);
        moveTooltip(event);

        const currentOpacity = parseFloat(d3.select(this).attr("fill-opacity"));
        if (currentOpacity > 0.05) {
            d3.select(this)
                .attr("fill-opacity", 0.4)
                .attr("stroke-opacity", 0.9);
        }
    }

    function handleHullMouseMove(event) {
        if (interactive) moveTooltip(event);
    }

    function handleHullMouseOut() {
        if (interactive) tooltip.style("opacity", 0);
        const currentOpacity = parseFloat(d3.select(this).attr("fill-opacity"));
        if (currentOpacity > 0.05) {
            d3.select(this)
                .attr("fill-opacity", 0.25)
                .attr("stroke-opacity", 0.75);
        }
    }

    // --- 1. DRAW HULLS ---
    const hullPadding = 20;
    const curve = d3.line().curve(d3.curveBasisClosed);

    function getHullPath(clusterNode) {
        const allMembers = clusterMembers.get(clusterNode.id) || [];
        const visibleMembers = allMembers.filter(m => titleAccessor(m) !== "CLUSTER");

        if (visibleMembers.length === 0) return "";

        const points = [];
        visibleMembers.forEach(m => {
            if (!m.x || !m.y) return;
            const r = getNodeVisualRadius(m) + hullPadding;
            points.push([m.x - r, m.y]);
            points.push([m.x + r, m.y]);
            points.push([m.x, m.y - r]);
            points.push([m.x, m.y + r]);
        });

        const hullPoints = d3.polygonHull(points);
        return hullPoints ? curve(hullPoints) : "";
    }

    const hullData = nodes.filter(d => titleAccessor(d) === "CLUSTER");
    let hulls = hullGroup.selectAll("path")
        .data(hullData)
        .enter()
        .append("path")
        .attr("class", "hull")
        .attr("fill", d => getClusterColor(d).fill)
        .attr("stroke", d => getClusterColor(d).stroke)
        .attr("fill-opacity", 0.25)
        .attr("stroke-opacity", 0.75)
        .on("click", handleHullClick)
        .on("mouseover", handleHullMouseOver)
        .on("mousemove", handleHullMouseMove)
        .on("mouseout", handleHullMouseOut);


    // --- 2. DRAW LINKS ---
    const visualEdges = cleanedEdges.filter(e => {
        const sType = titleAccessor(nodeById.get(e.source));
        const tType = titleAccessor(nodeById.get(e.target));
        return sType !== "CLUSTER" && tType !== "CLUSTER";
    });

    // --- DISEGNO DEI LINK CON DIFFERENZIAZIONE SEMANTICA ---
    let link = linkGroup.selectAll("line")
        .data(visualEdges)
        .enter()
        .append("line")
        .attr("class", "link")
        // Colore base dei link
        .attr("stroke", "#bbb")
        // Spessore differenziato
        .attr("stroke-width", d => {
            const sType = titleAccessorGlobal(nodeById.get(d.source.id || d.source));
            const tType = titleAccessorGlobal(nodeById.get(d.target.id || d.target));
            return (sType === "ENTITY" || tType === "ENTITY") ? 1.2 : 1.2;
        })
        // TRATTEGGIO: Solo per le Keywords (ENTITY)
        .style("stroke-dasharray", d => {
            const sType = titleAccessorGlobal(nodeById.get(d.source.id || d.source));
            const tType = titleAccessorGlobal(nodeById.get(d.target.id || d.target));
            return (sType === "ENTITY" || tType === "ENTITY") ? "4,3" : "none";
        })
        // Opacità ridotta per le connessioni AI
        .attr("stroke-opacity", d => {
            const sType = titleAccessorGlobal(nodeById.get(d.source.id || d.source));
            const tType = titleAccessorGlobal(nodeById.get(d.target.id || d.target));
            return (sType === "ENTITY" || tType === "ENTITY") ? 0.25 : 0.6;
        });

    // --- 3. DRAW NODES ---
    let node = nodeGroup.selectAll("path")
        .data(nodes)
        .enter()
        .append("path")
        .attr("class", "node")
        .attr("d", d => {
            const shapeType = getShapeByType(titleAccessor(d));
            const radius = getNodeVisualRadius(d);
            const size = Math.PI * Math.pow(radius, 2);
            const symbolType = (shapeType === "diamond") ? d3.symbolDiamond : d3.symbolCircle;
            return d3.symbol().type(symbolType).size(size)();
        })
        .attr("fill", d => getNodeColor(d))
        .attr("stroke", d => hexToRgba(getNodeColor(d), 0.45))
        .attr("stroke-width", 2)
        .attr("opacity", d => titleAccessor(d) === "CLUSTER" ? 0 : 1)
        .style("pointer-events", d => titleAccessor(d) === "CLUSTER" ? "none" : "all")
        .on("mouseover", handleNodeMouseOver)
        .on("mousemove", handleNodeMouseMove)
        .on("mouseout", handleNodeMouseOut)
        .on("click", handleNodeClick)
        .call(dragBehaviour());

    // --- 4. LABELS ---
    let labels = labelGroup.selectAll("text.node-label")
        .data(nodes)
        .enter()
        .append("text")
        .attr("class", "node-label")
        .text(d => {
            const type = titleAccessor(d);
            if (type === "CLUSTER" || type === "SUBJECT") return "";

            return d.detail__title ? truncate(d.detail__title, 30) : "";
        })
        .attr("dy", -10);

    // --- FUNZIONE GESTIONE LIVELLI (REDEFINED) ---
    window.updateGraphDepth = function (level, keepRevealed = false) {
        if (!interactive) return;

        // Reset manual expansion only if triggered by nav bar (not by node click)
        if (!keepRevealed) {
            currentDepthLevel = level;
            revealedNodes.clear();

            // Se cambiamo livello e il nodo selezionato sparisce, nascondi l'anello
            if (selectedNodeData) {
                selectedNodeData = null;
                selectionRing.style("opacity", 0);
            }

            document.querySelectorAll('.nav-btn').forEach((btn, idx) => {
                if ((idx + 1) === level) btn.classList.add('active');
                else btn.classList.remove('active');
            });
        }

        // Hybrid Visibility Logic con filtro temporale
        const isNodeVisible = (d) => {
            // Filtro TEMPO: Nodo non visibile se nel futuro
            if (d.timestamp && d.timestamp > currentTime) return false;

            // Rule 1: Explicitly revealed
            if (revealedNodes.has(d.id)) return true;

            const t = titleAccessorGlobal(d);

            if (currentDepthLevel === 0) {
                return t === 'SUBJECT';
            }
            if (currentDepthLevel === 1) {
                return t === 'SUBJECT' || t === 'POSITION';
            }
            if (currentDepthLevel === 2) {
                return t !== 'ENTITY';
            }
            return true;
        };

        // Filtra i nodi e gli edge visibili
        const visibleNodes = globalNodes.filter(isNodeVisible);
        const visibleNodeIds = new Set(visibleNodes.map(d => d.id));
        
        // Edges per la fisica (tutti quelli tra nodi visibili, inclusi i cluster per mantenere la struttura)
        const physicsEdges = globalEdges.filter(e => 
            visibleNodeIds.has(e.source.id || e.source) && 
            visibleNodeIds.has(e.target.id || e.target)
        );

        // Edges da disegnare (escludi quelli verso i CLUSTER per pulizia visiva)
        const renderEdges = physicsEdges.filter(e => {
            const s = (typeof e.source === 'object') ? e.source : globalNodes.find(n => n.id === e.source);
            const t = (typeof e.target === 'object') ? e.target : globalNodes.find(n => n.id === e.target);
            return titleAccessorGlobal(s) !== "CLUSTER" && titleAccessorGlobal(t) !== "CLUSTER";
        });

        // Aggiorna la simulazione con i nuovi nodi ed edge
        if (simulation) {
            simulation.nodes(visibleNodes);
            simulation.force("link").links(physicsEdges);
            simulation.alpha(0.3).restart();
        }

        // Rebind dei dati ai nodi visivi
        const nodeSelection = nodeGroup.selectAll("path").data(visibleNodes, d => d.id);
        nodeSelection.exit().remove();
        const nodeEnter = nodeSelection.enter()
            .append("path")
            .attr("class", "node")
            .attr("d", d => {
                const shapeType = getShapeByType(titleAccessorGlobal(d));
                const radius = getNodeVisualRadius(d);
                const size = Math.PI * Math.pow(radius, 2);
                const symbolType = (shapeType === "diamond") ? d3.symbolDiamond : d3.symbolCircle;
                return d3.symbol().type(symbolType).size(size)();
            })
            .attr("fill", d => getNodeColor(d))
            .attr("stroke", d => hexToRgba(getNodeColor(d), 0.45))
            .attr("stroke-width", 2)
            .attr("opacity", 0) // Start invisible
            .style("pointer-events", d => titleAccessorGlobal(d) === "CLUSTER" ? "none" : "all")
            .on("mouseover", handleNodeMouseOver)
            .on("mousemove", handleNodeMouseMove)
            .on("mouseout", handleNodeMouseOut)
            .on("click", handleNodeClick)
            .call(dragBehaviour());

        // Staggered appearance for new nodes
        const isTutorialOpen = !document.getElementById("tutorial-sidebar").classList.contains('tutorial-closed');
        const shouldStagger = isTimelineUpdate && !isTutorialOpen;

        const enterSize = nodeEnter.size();
        const staggerDelay = shouldStagger ? (enterSize > 50 ? 5 : 10) : 0;

        nodeEnter.transition()
            .duration(0)
            .delay((d, i) => i * staggerDelay)
            .attr("opacity", d => titleAccessorGlobal(d) === "CLUSTER" ? 0 : 1);

        // Rebind delle labels
        const labelSelection = labelGroup.selectAll("text.node-label").data(visibleNodes, d => d.id);
        labelSelection.exit().remove();
        labelSelection.enter()
            .append("text")
            .attr("class", "node-label")
            .text(d => {
                const type = titleAccessorGlobal(d);
                if (type === "CLUSTER" || type === "SUBJECT") return "";
                return d.detail__title ? truncate(d.detail__title, 30) : "";
            })
            .attr("dy", -10)
            .attr("opacity", 0)
            .transition()
            .duration(0)
            .delay((d, i) => i * staggerDelay)
            .attr("opacity", 1);

        // Rebind dei link
        const linkSelection = linkGroup.selectAll("line").data(renderEdges, d => `${d.source.id || d.source}-${d.target.id || d.target}`);
        linkSelection.exit().remove();
        linkSelection.enter()
            .append("line")
            .attr("class", "link")
            .attr("stroke", "#bbb")
            .attr("stroke-width", d => {
                const sType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.source.id || d.source)));
                const tType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.target.id || d.target)));
                return (sType === "ENTITY" || tType === "ENTITY") ? 1.2 : 1.2;
            })
            .style("stroke-dasharray", d => {
                const sType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.source.id || d.source)));
                const tType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.target.id || d.target)));
                return (sType === "ENTITY" || tType === "ENTITY") ? "4,3" : "none";
            })
            .attr("stroke-opacity", 0)
            .transition()
            .duration(0)
            .delay((d, i) => i * staggerDelay)
            .attr("stroke-opacity", d => {
                const sType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.source.id || d.source)));
                const tType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.target.id || d.target)));
                return (sType === "ENTITY" || tType === "ENTITY") ? 0.25 : 0.6;
            });

        // Aggiorna hulls
        const hullData = visibleNodes.filter(d => titleAccessorGlobal(d) === "CLUSTER");
        const hullSelection = hullGroup.selectAll("path").data(hullData, d => d.id);
        hullSelection.exit().remove();
        
        const hullOpacity = d => {
            const members = globalClusterMembers.get(d.id) || [];
            // La hull compare solo quando TUTTI i nodi che contiene sono comparsi nella timeline
            const allMembersAppeared = members.every(m => !m.timestamp || m.timestamp <= currentTime);
            return allMembersAppeared ? 1 : 0;
        };

        hullSelection
            .style("opacity", hullOpacity)
            .style("pointer-events", function(d) {
                return hullOpacity(d) == 0 ? "none" : "all";
            });

        hullSelection.enter()
            .append("path")
            .attr("class", "hull")
            .attr("fill", d => getClusterColor(d).fill)
            .attr("stroke", d => getClusterColor(d).stroke)
            .attr("fill-opacity", 0.25)
            .attr("stroke-opacity", 0.75)
            .style("opacity", hullOpacity)
            .style("pointer-events", function(d) {
                return hullOpacity(d) == 0 ? "none" : "all";
            })
            .on("click", handleHullClick)
            .on("mouseover", handleHullMouseOver)
            .on("mousemove", handleHullMouseMove)
            .on("mouseout", handleHullMouseOut);

        // Aggiorna le variabili globali per la simulazione
        node = nodeGroup.selectAll("path");
        link = linkGroup.selectAll("line");
        labels = labelGroup.selectAll("text.node-label");
        hulls = hullGroup.selectAll("path");

        if (interactive && !keepRevealed) {
            clearNodeDetails();
            resetHighlight();
        }
    };

    let simulation;
    let collisionForce;

    function initSimulation() {
        initCollisionForce();

        simulation = d3.forceSimulation(globalNodes)
            // Forza di attrazione dei legami
            .force("link", d3.forceLink(globalEdges)
                .id(d => d.id)
                .distance(getLinkDistance)
                .strength(d => {
                    // Legami strutturali più rigidi, menzioni più elastiche
                    if (d.mainStat === "HAS_POSITION") return 0.7;
                    if (d.mainStat === "MENTION") return 0.2;
                    return 0.4;
                })
            )
            // Repulsione (Charge) bilanciata per gerarchia
            .force("charge", d3.forceManyBody()
                .strength(d => {
                    const type = titleAccessorGlobal(d);
                    if (type === "SUBJECT") return -1000; // Il centro spinge per farsi spazio
                    if (type === "ENTITY") return -50;    // Le keyword non disturbano la struttura
                    return -300; // Posizioni e Argomenti hanno una repulsione media
                })
                .distanceMax(500)
            )
            // Forza centripeta differenziata (mantiene il Soggetto al centro)
            .force("x", d3.forceX(width / 2).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.05))
            .force("y", d3.forceY(height / 2).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.05))
            .force("collision", collisionForce)
            .force("clustering", createClusteringForce())
            .on("tick", ticked);

        simulation.alphaDecay(0.01); // Raffreddamento leggermente più veloce per stabilità

        simulation.alphaMin(0.001);
    }

    function getLinkDistance(d) {
        const sType = titleAccessorGlobal(d.source);
        const tType = titleAccessorGlobal(d.target);
        const rSource = getNodeVisualRadius(d.source);
        const rTarget = getNodeVisualRadius(d.target);

        // Distanza base ridotta rispetto all'originale per un grafo più compatto
        let baseDist = 60 + rSource + rTarget;

        if (sType === "ENTITY" || tType === "ENTITY") {
            const ent = sType === "ENTITY" ? d.source : d.target;
            if (ent._open) return baseDist + 80; // Più spazio se la keyword è aperta
            return baseDist - 20; // Keyword chiuse molto vicine ai loro argomenti
        }

        if (d.mainStat === "HAS_POSITION") return baseDist; // Subject -> Position
        return baseDist + 40; // Altri legami più lunghi
    }

    function initCollisionForce() {
        collisionForce = d3.forceCollide()
            .radius(d => {
                // Disattiva collisione per i nodi CLUSTER (che sono invisibili)
                if (titleAccessorGlobal(d) === "CLUSTER") return 0;

                const baseRadius = getNodeVisualRadius(d);
                // Buffer ridotto: 6px per nodi normali, 12px per nodi aperti
                const buffer = d._open ? 12 : 6;
                return baseRadius + buffer + (d._extraCollision || 0);
            })
            .strength(0.2) // Forza alta per evitare sovrapposizioni
            .iterations(4); // Più iterazioni = calcolo fisico più preciso e meno vibrazioni
    }

    // Custom clustering force: attira i nodi verso il loro nodo CLUSTER
    function createClusteringForce() {
        return (alpha) => {
            const clusterStrength = 20; // Forza di attrazione verso il cluster (ridotta, ma più consistente)

            globalClusterMembers.forEach((members, clusterId) => {
                const clusterNode = globalNodes.find(n => n.id === clusterId);
                if (!clusterNode || clusterNode.x === undefined) return;

                // Attira ogni membro verso il nodo CLUSTER
                const visibleMembers = members.filter(m => titleAccessorGlobal(m) !== "CLUSTER" && m.x !== undefined);

                visibleMembers.forEach(node => {
                    const dx = clusterNode.x - node.x;
                    const dy = clusterNode.y - node.y;
                    const distance = Math.sqrt(dx * dx + dy * dy);

                    if (distance > 1) { // Evita divisione per zero
                        const force = clusterStrength * alpha * alpha; // Usa alpha^2 per scalare meglio nel tempo
                        node.vx += (dx / distance) * force;
                        node.vy += (dy / distance) * force;
                    }
                });
            });
        };
    }

    function updateSimulationCenter(tutorialOpen) {
        if (!simulation) return;

        const sidebarWidth = tutorialOpen ? 360 : 0;
        const graphContainerWidth = document.getElementById("graph-container").clientWidth;
        const cx = sidebarWidth + (graphContainerWidth - sidebarWidth) / 2;
        const cy = height / 2;

        simulation.force("center", d3.forceCenter(cx, cy));
        simulation.force("x", d3.forceX(cx).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.05));
        simulation.force("y", d3.forceY(cy).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.05));
        simulation.alpha(0.5).restart();
    }

    let tickCount = 0;

    function ticked() {
        tickCount++;

        // Aggiorna posizioni Archi
        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        // Aggiorna posizioni Nodi
        node.attr("transform", d => `translate(${d.x},${d.y})`);

        // Aggiorna posizione Anello di Selezione
        if (selectedNodeData) {
            selectionRing.attr("cx", selectedNodeData.x).attr("cy", selectedNodeData.y);
        }

        // Aggiorna etichette fisse e hover
        labels.attr("x", d => d.x).attr("y", d => d.y - 10);
        labelGroup.selectAll(".entity-hover-label, .entity-perm-label")
            .attr("x", d => d.x)
            .attr("y", d => d.y);

        labelGroup.selectAll(".entity-perm-label")
            .attr("transform", d => `translate(${d.x},${d.y})`);

        // OTTIMIZZAZIONE: Calcola gli Hull solo ogni 3 tick per risparmiare CPU
        if (tickCount % 3 === 0) {
            hulls.attr("d", d => getHullPath(d));
        }

        // Aggiorna nodi Minimappa
        const mContainer = document.getElementById("minimap-container");
        const mSize = mContainer ? mContainer.clientWidth : 160;
        const subjectNode = globalNodes.find(n => titleAccessorGlobal(n) === "SUBJECT");
        const refX = subjectNode && subjectNode.x !== undefined ? subjectNode.x : width / 2;
        const refY = subjectNode && subjectNode.y !== undefined ? subjectNode.y : height / 2;

        minimapNodes
            .attr("cx", d => (d.x - refX) * minimapScale + mSize / 2)
            .attr("cy", d => (d.y - refY) * minimapScale + mSize / 2);
        
        // Aggiorna viewport minimappa (nel caso la simulazione sposti il centro o all'avvio)
        if (updateMinimapViewport) updateMinimapViewport(d3.zoomTransform(svg.node()));
    }

    function dragBehaviour() {
        function dragstarted(event, d) {
            if (!interactive) return;
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }

        function dragged(event, d) {
            if (!interactive) return;
            d.fx = event.x;
            d.fy = event.y;
        }

        function dragended(event, d) {
            if (!interactive) return;
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }

        return d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended);
    }

    function buildTooltipHTML(d) {
        const title = d.detail__title || "";
        let type = d.mainStat || titleAccessor(d) || "unknown";
        if (type === "ENTITY") type = "KEYWORD";
        const sub = d.subStat || "";
        const text = d.detail__text || "";

        const titleHTML = title ? `<strong>${escapeHTML(title)}</strong><br/>` : "";

        return `
            ${titleHTML}
            <div style="font-family: var(--font-mono); font-size: var(--fs-small); text-transform: uppercase; margin-bottom: 4px; color: var(--color-primary);">${escapeHTML(type)}${sub ? " · " + escapeHTML(sub) : ""}</div>
            <div style="font-size: 11px; margin-bottom: 8px; line-height: 1.4;">${escapeHTML(truncate(text, 140))}</div>
            <div style="font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; opacity: 0.6; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px;">Click for details</div>
        `;
    }

    function moveTooltip(event) {
        const padding = 15;
        const tooltipNode = tooltip.node();
        const bBox = tooltipNode.getBoundingClientRect();

        let x = event.pageX + padding;
        let y = event.pageY + padding;

        // Controllo margine destro: se esce, lo sposta a sinistra del cursore
        if (x + bBox.width > window.innerWidth) {
            x = event.pageX - bBox.width - padding;
        }

        // Controllo margine inferiore: se esce, lo sposta sopra il cursore
        if (y + bBox.height > window.innerHeight) {
            y = event.pageY - bBox.height - padding;
        }

        // Controllo margine superiore: se dopo lo spostamento esce sopra, lo riporta sotto
        if (y < 0) y = event.pageY + padding;

        tooltip
            .style("left", x + "px")
            .style("top", y + "px");
    }

    svg.on("click", () => {
        if (!interactive) return;
        clearNodeDetails();
        resetHighlight();
        resetEntitiesVisuals();
        
        // Reset anello selezione
        selectedNodeData = null;
        selectionRing.style("opacity", 0);

        // Pulisci la ricerca se si clicca sullo sfondo
        const searchInput = document.getElementById("search-input");
        if (searchInput) searchInput.value = "";

        // Rimuovi selezione visiva
        nodeGroup.selectAll(".node").classed("selected", false);
    });

    let currentSelectedNodeId = null; // Gestione race condition per richieste asincrone

    async function addWikipediaLink(keyword, containerElement, nodeId) {
        // API Wikipedia (Italiano come da richiesta)
        const url = `https://it.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keyword)}&format=json&origin=*`;

        try {
            const response = await fetch(url);
            const data = await response.json();

            // Se l'utente ha cambiato nodo nel frattempo, interrompi
            if (nodeId !== currentSelectedNodeId) return;

            if (data.query && data.query.search && data.query.search.length > 0) {
                const bestMatch = data.query.search[0].title;
                const wikiUrl = `https://it.wikipedia.org/wiki/${encodeURIComponent(bestMatch.replace(/ /g, "_"))}`;
                
                // Crea contenitore per il bottone per separarlo dal testo
                const btnContainer = document.createElement("div");
                btnContainer.style.marginTop = "12px";
                
                // Bottone con stile
                btnContainer.innerHTML = `<a href="${wikiUrl}" target="_blank" class="wiki-btn">Read more on Wikipedia →</a>`;
                
                containerElement.appendChild(btnContainer);
            }
        } catch (error) {
            console.error("Errore Wikipedia API:", error);
        }
    }

    function showNodeDetails(d) {
        const detailsCard = d3.select("#details-card");
        detailsCard.classed("visible", true);
        
        // Aggiorna ID corrente per gestire le richieste async
        currentSelectedNodeId = d.id;

        // --- 1. HEADER: User & Type ---
        const avatarContainer = d3.select("#user-avatar");
        const nameContainer = d3.select("#user-name");
        const typesContainer = d3.select("#node-types");
        
        typesContainer.selectAll("*").remove();
        avatarContainer.selectAll("*").remove();

        // Determine User/Author
        let authorName = "System";
        let isHuman = false;

        if (d.detail__author_id) {
            const cleanAuthorId = String(d.detail__author_id).replace(/['"]+/g, '').trim();
            const mapName = authorMap.get(cleanAuthorId);
            authorName = mapName || "Anonymous User";
            isHuman = true;
        } else {
            // Fallback for non-human nodes
            const t = titleAccessorGlobal(d);
            if (t === "CLUSTER") authorName = "Cluster";
            else if (t === "ENTITY") authorName = String(d.detail__value || d.detail__title || "Keyword").replace(/['"]+/g, '').trim();
            else if (t === "SUBJECT") authorName = "Topic";
        }

        nameContainer.text(authorName);

        // Avatar Icon
        if (isHuman) {
            avatarContainer.html(`
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                </svg>
            `);
        } else {
            avatarContainer.html(`
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
            `);
        }

        // Node Type Pill
        let nodeType = titleAccessorGlobal(d);
        if (nodeType === "CLUSTER") nodeType = "ARGUMENT CLUSTER";
        if (nodeType === "ENTITY") nodeType = "KEYWORD";

        // Calcola il colore base per la pillola
        let typeColor;
        if (titleAccessorGlobal(d) === "CLUSTER") {
            typeColor = getClusterColor(d).stroke; // Usa il colore del bordo del cluster
        } else {
            typeColor = getNodeColor(d);
        }

        typesContainer.append("span")
            .attr("class", "pill")
            .style("background-color", hexToRgba(typeColor, 0.15)) // Tinta leggera
            .style("border", `1px solid ${hexToRgba(typeColor, 0.3)}`) // Bordo sottile coordinato
            .text(nodeType);

        const displayTitle = (titleAccessorGlobal(d) === "CLUSTER") ?
            (d.detail__tagline || d.detail__title || "—") :
            (d.detail__title || "—");

        const displayText = (titleAccessorGlobal(d) === "CLUSTER") ?
            (d.detail__summary || d.detail__text || "") :
            (d.detail__text || "");

        d3.select("#node-title").text(displayTitle);
        const textContainer = d3.select("#node-text");
        textContainer.text(displayText);

        const nodeValueContainer = d3.select("#node-value");
        nodeValueContainer.html("");

        if (titleAccessorGlobal(d) === "POSITION") {
            let pro = 0;
            let con = 0;
            const getId = (n) => (typeof n === 'object' && n.id) ? n.id : n;

            globalEdges.forEach(e => {
                const sId = getId(e.source);
                const tId = getId(e.target);
                if (sId === d.id || tId === d.id) {
                    const neighborId = (sId === d.id) ? tId : sId;
                    const neighborNode = nodeById.get(neighborId);
                    if (neighborNode) {
                        const type = titleAccessorGlobal(neighborNode);
                        if (type === "INFAVOR") pro++;
                        if (type === "AGAINST") con++;
                    }
                }
            });

            const createPill = (count, label, color) => {
                return `
                    <div style="flex: 1; display: flex; flex-direction: column; padding: 12px; background: var(--c-bg-panel); border: 1px solid var(--c-border);">
                        <span style="font-family: var(--font-mono); font-size: var(--fs-small); color: var(--c-text-muted); text-transform: uppercase; margin-bottom: 4px;">${label}</span>
                        <span style="font-family: var(--font-mono); font-size: 18px; font-weight: var(--fw-bold); color: ${color};">${count}</span>
                    </div>`;
            };

            let html = `<div style="display: flex; gap: 10px; width: 100%;">`;
            html += createPill(pro, "INFAVOUR", colorMap["INFAVOR"]);
            html += createPill(con, "AGAINST", colorMap["AGAINST"]);
            html += `</div>`;
            nodeValueContainer.html(html);

        } else if (titleAccessorGlobal(d) === "CLUSTER") {
            const allMems = globalClusterMembers.get(d.id) || [];
            const visMems = allMems.filter(m => titleAccessorGlobal(m) !== "CLUSTER");
            nodeValueContainer.text(`This area groups ${visMems.length} connected argument(s).`);
        } else {
            let stats = "";
            if (d.detail__value && d.detail__value !== "") {
                stats = `Value: ${String(d.detail__value).replace(/['"]+/g, '')}`;
            }
            nodeValueContainer.text(stats);
        }

        // --- WIKIPEDIA INTEGRATION ---
        // Se è una Keyword (ENTITY), cerca su Wikipedia
        if (titleAccessorGlobal(d) === "ENTITY") {
            let keyword = d.detail__value || d.detail__title;
            if (keyword) {
                keyword = String(keyword).replace(/['"]+/g, '').trim();
                addWikipediaLink(keyword, textContainer.node(), d.id);
            }
        }
    }

    function showConnectedEntitiesText(argNode) {
        if (!argNode) return;

        const connected = edges.map(e => {
            if (e.source.id === argNode.id) return e.target;
            if (e.target.id === argNode.id) return e.source;
            return null;
        }).filter(Boolean).filter(n => titleAccessor(n) === "ENTITY");

        connected.forEach(ent => {
            const existing = labelGroup.selectAll('.entity-perm-label').filter(d => d.id === ent.id);
            if (!existing.empty()) return;

            node.filter(n => n.id === ent.id)
                .attr('opacity', 0.1);

            const g = labelGroup.append('g')
                .datum(ent)
                .attr('class', 'entity-perm-label')
                .style('pointer-events', 'none');

            const textVal = ent.detail__value || ent.detail__title || '';

            const textEl = g.append('text')
                .attr('text-anchor', 'middle')
                .attr('alignment-baseline', 'middle')
                .text(truncate(textVal, 180));

            requestAnimationFrame(() => {
                try {
                    const bbox = textEl.node().getBBox();
                    const pad = 8;
                    ent._open = true;
                    const measured = Math.max(bbox.width, bbox.height);
                    const reduced = Math.max(4, measured / 8);
                    const cap = 30;
                    ent._extraCollision = Math.min(reduced + pad + 6, cap);

                    if (collisionForce && simulation) {
                        collisionForce.radius(d => (getNodeVisualRadius(d) + 5 + (d._extraCollision || 0)));
                        simulation.force("collision", collisionForce);

                        // NUOVO: Aggiorna le distanze dei link ora che ent._open è true
                        simulation.force("link").links(edges);

                        simulation.alpha(0.1).restart();
                    }
                    g.attr('transform', `translate(${ent.x},${ent.y})`);
                } catch (e) {
                    g.attr('transform', `translate(${ent.x},${ent.y})`);
                }
            });
        });
    }

    function resetEntitiesVisuals() {
        labelGroup.selectAll('.entity-perm-label').remove();
        node.filter(d => titleAccessor(d) === 'ENTITY')
            .attr('opacity', 1);

        nodes.forEach(n => {
            n._open = false;
            n._extraCollision = 0;
        });

        if (collisionForce) {
            collisionForce.radius(d => (getNodeVisualRadius(d) + 5 + (d._extraCollision || 0)));
            if (simulation) {
                simulation.force("collision", collisionForce);
                simulation.force("link").links(edges);
                simulation.alpha(0.05).restart();
            }
        }
    }

    function clearNodeDetails() {
        // MODIFICA UI: Nascondiamo la card inferiore rimuovendo la classe visible
        d3.select("#details-card").classed("visible", false);
    }

    function truncate(str, max) {
        if (!str) return "";
        return str.length > max ? str.slice(0, max - 1) + "…" : str;
    }

    function escapeHTML(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    const legendContainer = d3.select("#legend");

    legendContainer.append("div")
        .attr("id", "legend-title");

    const legendTypes = Object.keys(colorMap).filter(k =>
        k !== "default" &&
        k !== "QUOTE" &&
        k !== "ARGUMENT"
    );

    const legendItemCluster = legendContainer.append("div").attr("class", "legend-item");

    legendItemCluster.append("div")
        .attr("class", "legend-symbol")
        .style("background-color", "#e2e8f0") // Deve corrispondere a clusterFillColor
        .style("border", "2px solid #94a3b8")  // Deve corrispondere a clusterStrokeColor
        .style("opacity", "0.8") // Un po' più visibile in legenda
        .style("border-radius", "2px");
    legendItemCluster.append("span").text("CLUSTER AREA (Selectable)");

    const legendItems = legendContainer.selectAll(".legend-item-node")
        .data(legendTypes)
        .enter()
        .append("div")
        .attr("class", "legend-item legend-item-node");

    legendItems.append("svg")
        .attr("class", "legend-symbol")
        .attr("width", 18)
        .attr("height", 18)
        .append("path")
        .attr("transform", "translate(9,9)")
        .attr("d", d => {
            const shapeType = getShapeByType(d);
            const symbolType = (shapeType === "diamond") ? d3.symbolDiamond : d3.symbolCircle;
            return d3.symbol().type(symbolType).size(70)();
        })
        .attr("fill", d => getNodeColorByType(d))
        .attr("stroke", d => hexToRgba(getNodeColorByType(d), 0.45))
        .attr("stroke-width", 1);

    legendItems.append("span")
        .text(d => d === "ENTITY" ? "KEYWORD" : d);

    legendContainer.append("div")
        .style("margin-top", "10px")
        .style("font-size", "11px")
        .style("color", "#666")
        .html(`Node size = total connections (degree)`);

    function zoomToNodes(filterFn) {
        const selected = nodes.filter(filterFn);
        if (selected.length === 0) return;

        const margin = 80;

        const minX = d3.min(selected, d => d.x);
        const maxX = d3.max(selected, d => d.x);
        const minY = d3.min(selected, d => d.y);
        const maxY = d3.max(selected, d => d.y);

        const widthSel = maxX - minX || 1;
        const heightSel = maxY - minY || 1;

        const availableWidth = document.getElementById("graph-container").clientWidth;
        const availableHeight = document.getElementById("graph-container").clientHeight;

        const scale = Math.min(
            (availableWidth - margin) / widthSel,
            (availableHeight - margin) / heightSel,
            2
        );

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        const transform = d3.zoomIdentity
            .translate(availableWidth / 2, availableHeight / 2)
            .scale(scale)
            .translate(-centerX, -centerY);

        svg.transition().duration(800).call(zoom.transform, transform);
    }

    function resetZoom() {
        svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity);
    }

    const topDegreeNodes = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 5);

    let currentStep = 0;

    const tutorialContent = document.getElementById("tutorial-content");
    const tutorialNext = document.getElementById("tutorial-next");
    const tutorialBack = document.getElementById("tutorial-back");
    const tutorialSkip = document.getElementById("tutorial-skip");
    const tutorialStepper = document.getElementById("tutorial-stepper");
    const tutorialSidebar = document.getElementById("tutorial-sidebar");
    const tutorialToggle = document.getElementById("tutorial-toggle");
    const infoPanel = document.getElementById("info-panel");
    const depthNav = document.getElementById("depth-nav");

    function collapseInfoPanel() {
        if (!infoPanel) return;
        infoPanel.classList.add('collapsed');
    }

    function expandInfoPanel() {
        if (!infoPanel) return;
        infoPanel.classList.remove('collapsed');
    }

    function updateStepper() {
        tutorialStepper.innerHTML = "";
        tutorialSteps.forEach((_, i) => {
            const dot = document.createElement("div");
            dot.className = "step-dot";
            if (i === currentStep) dot.classList.add("active");
            tutorialStepper.appendChild(dot);
        });
    }

    function applyTutorialFocus() {
        const step = tutorialSteps[currentStep];
        const type = step.focusType;

        if (type === "ALL" || !type) {
            resetHighlight();
            resetZoom();
            return;
        }

        const targetNodes = globalNodes.filter(d => {
            const t = titleAccessorGlobal(d);
            if (type === "SUBJECT") return t === "SUBJECT";
            if (type === "POSITION") return t === "POSITION";
            if (type === "INFAVOR_AGAINST") return t === "INFAVOR" || t === "AGAINST";
            if (type === "CLUSTER") return t === "CLUSTER";
            if (type === "ENTITY") return t === "ENTITY";
            return false;
        });

        if (targetNodes.length > 0) {
            const targetIds = new Set(targetNodes.map(n => n.id));
            
            let filterFn = n => targetIds.has(n.id);
            // Mantieni visibili i nodi strutturali (padri) per mostrare i collegamenti
            if (type === "POSITION") {
                filterFn = n => targetIds.has(n.id) || titleAccessorGlobal(n) === "SUBJECT";
            } else if (type === "INFAVOR_AGAINST") {
                filterFn = n => targetIds.has(n.id) || titleAccessorGlobal(n) === "SUBJECT" || titleAccessorGlobal(n) === "POSITION";
            }
            highlightNodes(filterFn);

            // FUNZIONE RECORSIVA PER ATTENDERE LE COORDINATE
            const performZoom = (attempts) => {
                const minX = d3.min(targetNodes, d => d.x);
                const maxX = d3.max(targetNodes, d => d.x);

                // Se le coordinate sono ancora identiche (tutti al centro), riprova tra 100ms
                if (minX === maxX && attempts < 10) {
                    setTimeout(() => performZoom(attempts + 1), 100);
                    return;
                }

                const minY = d3.min(targetNodes, d => d.y);
                const maxY = d3.max(targetNodes, d => d.y);

                const selWidth = (maxX - minX) || 100;
                const selHeight = (maxY - minY) || 100;
                const midX = (minX + maxX) / 2;
                const midY = (minY + maxY) / 2;

                const isSidebarOpen = !document.getElementById("tutorial-sidebar").classList.contains('tutorial-closed');
                const sidebarOffset = isSidebarOpen ? 360 : 0;
                const availableWidth = width - sidebarOffset;

                let scale = Math.min(2.5, 0.7 / Math.max(selWidth / availableWidth, selHeight / height));
                if (targetNodes.length === 1) scale = 1.8;

                const centerX = sidebarOffset + (availableWidth / 2);
                const centerY = height / 2;

                svg.transition()
                    .duration(1500)
                    .ease(d3.easeCubicInOut)
                    .call(zoom.transform, d3.zoomIdentity
                        .translate(centerX, centerY)
                        .scale(scale)
                        .translate(-midX, -midY)
                    );
            };

            performZoom(0);
        }
    }

    function updateTutorial() {
        const step = tutorialSteps[currentStep];

        // Storytelling: Update Graph Depth based on step
        if (currentStep === 0) updateGraphDepth(3);      // Intro: Full
        else if (currentStep === 1) updateGraphDepth(0); // Subject: Subject Only
        else if (currentStep === 2) updateGraphDepth(1); // Positions: Level 1
        else if (currentStep === 3) updateGraphDepth(2); // Arguments: Level 2
        else if (currentStep === 4) updateGraphDepth(2); // Clusters: Level 2
        else if (currentStep === 5) updateGraphDepth(3); // Keywords: Level 3
        else updateGraphDepth(3);

        tutorialContent.innerHTML = `
        <h2>${step.title}</h2>
        <p>${step.text}</p>
        <div class="tutorial-visual">
            ${step.visual}
        </div>
    `;

        updateStepper();
        applyTutorialFocus();

        // Gestione stato bottoni
        tutorialBack.disabled = currentStep === 0;
        tutorialNext.innerText = currentStep === tutorialSteps.length - 1 ? "Close" : "Next →";

        if (!tutorialSidebar.classList.contains('tutorial-closed')) {
            collapseInfoPanel();
            updateSimulationCenter(true);
        }
    }

    // Funzione centralizzata per chiudere il tutorial (usata da Next all'ultimo step e da Skip)
    function endTutorial() {
        tutorialSidebar.classList.add('tutorial-closed');
        tutorialToggle.style.display = "block";
        interactive = true;
        expandInfoPanel();
        resetHighlight();
        resetZoom();
        updateSimulationCenter(false);
        updateGraphDepth(3); // Reset to full view
        depthNav.classList.remove('nav-hidden');
        // Mostra timeline
        const timelinePanel = document.getElementById("timeline-panel");
        if (timelinePanel) timelinePanel.classList.remove('nav-hidden');
        const searchPanel = document.getElementById("search-panel");
        if (searchPanel) searchPanel.classList.remove('nav-hidden');
        const minimapContainer = document.getElementById("minimap-container");
        if (minimapContainer) minimapContainer.classList.remove('nav-hidden');
        const resetViewContainer = document.getElementById("reset-view-container");
        if (resetViewContainer) resetViewContainer.classList.remove('nav-hidden');
        const exportViewContainer = document.getElementById("export-view-container");
        if (exportViewContainer) exportViewContainer.classList.remove('nav-hidden');
        const zoomInContainer = document.getElementById("zoom-in-container");
        if (zoomInContainer) zoomInContainer.classList.remove('nav-hidden');
        const zoomOutContainer = document.getElementById("zoom-out-container");
        if (zoomOutContainer) zoomOutContainer.classList.remove('nav-hidden');
    }

    // Funzione per calcolare la distanza dinamica degli archi
    function getLinkDistance(d) {
        const sType = titleAccessor(d.source);
        const tType = titleAccessor(d.target);

        // 1. Cluster Internal (Coesione MASSIMA)
        if (sType === "CLUSTER" || tType === "CLUSTER") return 15;

        // 2. Entity Logic
        if (sType === "ENTITY" || tType === "ENTITY") {
            const ent = sType === "ENTITY" ? d.source : d.target;

            // A. Se Aperta (Testo visibile): Rilassa molto per dare spazio alle parole
            if (ent._open) return 100;

            // B. Se Chiusa (Rombo) E connessa a 1 solo nodo: Molto vicina
            if (ent.degree === 1) return 1;

            // C. Se Chiusa ma connessa a più nodi: Distanza standard (per non tirare troppo il grafo)
            return 35;
        }

        // 3. Struttura Gerarchica Standard
        const rSource = getNodeVisualRadius(d.source || {});
        const rTarget = getNodeVisualRadius(d.target || {});
        return 140 + rSource + rTarget;
    }

    // Init
    initSimulation();

    // --- MINIMAP LOGIC ---
    const minimapSvg = d3.select("#minimap");
    const minimapScale = 0.1; // Fattore di scala per adattare il grafo alla minimappa

    // Gruppo contenitore per i nodi della minimappa
    const minimapContent = minimapSvg.append("g").attr("class", "minimap-content");
    
    // Rettangolo che rappresenta la vista corrente
    const minimapViewport = minimapSvg.append("rect")
        .attr("class", "minimap-viewport")
        .attr("fill", "none")
        .attr("stroke", "#9cc6e9")
        .attr("stroke-width", 0.001);

    // Crea i nodi semplificati nella minimappa
    const minimapNodes = minimapContent.selectAll("circle")
        .data(nodes)
        .enter()
        .append("circle")
        .attr("r", d => titleAccessorGlobal(d) === "SUBJECT" ? 3 : 1.5)
        .attr("fill", d => getNodeColor(d))
        .attr("opacity", 0.6);

    // Funzione per aggiornare il rettangolo della minimappa durante lo zoom
    updateMinimapViewport = function(t) {
        const mContainer = document.getElementById("minimap-container");
        const mSize = mContainer ? mContainer.clientWidth : 160;
        const subjectNode = globalNodes.find(n => titleAccessorGlobal(n) === "SUBJECT");
        const refX = subjectNode && subjectNode.x !== undefined ? subjectNode.x : width / 2;
        const refY = subjectNode && subjectNode.y !== undefined ? subjectNode.y : height / 2;

        // Calcola l'area visibile nel sistema di coordinate del grafo
        // x, y, w, h sono relativi allo spazio trasformato
        const vX = -t.x / t.k;
        const vY = -t.y / t.k;
        const vW = width / t.k;
        const vH = height / t.k;

        // Mappa le coordinate del grafo alle coordinate della minimappa
        // (0,0) del grafo -> centro della minimappa (80,80)
        const mapX = (val) => (val - refX) * minimapScale + mSize / 2;
        const mapY = (val) => (val - refY) * minimapScale + mSize / 2;

        const x_m = mapX(vX);
        const y_m = mapY(vY);
        const w_m = vW * minimapScale;
        const h_m = vH * minimapScale;

        minimapViewport
            .attr("x", x_m)
            .attr("y", y_m)
            .attr("width", w_m)
            .attr("height", h_m);
    };

    // --- RESET ZOOM TO FIT LOGIC ---
    function resetZoomToFit() {
        const nodesToFit = nodeGroup.selectAll(".node").data();
        if (nodesToFit.length === 0) return;

        const margin = 100;
        const bounds = {
            x0: d3.min(nodesToFit, d => d.x),
            x1: d3.max(nodesToFit, d => d.x),
            y0: d3.min(nodesToFit, d => d.y),
            y1: d3.max(nodesToFit, d => d.y)
        };

        const dx = bounds.x1 - bounds.x0;
        const dy = bounds.y1 - bounds.y0;
        const x = (bounds.x0 + bounds.x1) / 2;
        const y = (bounds.y0 + bounds.y1) / 2;

        const isSidebarOpen = !document.getElementById("tutorial-sidebar").classList.contains('tutorial-closed');
        const sidebarOffset = isSidebarOpen ? 360 : 0;
        const availableWidth = width - sidebarOffset;

        const scale = Math.min(2, 0.75 / Math.max(dx / availableWidth, dy / height));
        const translate = [sidebarOffset + availableWidth / 2 - scale * x, height / 2 - scale * y];

        svg.transition().duration(750).ease(d3.easeCubicInOut).call(
            zoom.transform,
            d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
        );
    }

    const resetViewBtn = document.getElementById("reset-view-btn");
    if (resetViewBtn) {
        resetViewBtn.addEventListener("click", resetZoomToFit);
    }

    // --- ZOOM CONTROLS LOGIC ---
    const zoomInBtn = document.getElementById("zoom-in-btn");
    if (zoomInBtn) {
        zoomInBtn.addEventListener("click", () => {
            svg.transition().duration(300).call(zoom.scaleBy, 1.3);
        });
    }

    const zoomOutBtn = document.getElementById("zoom-out-btn");
    if (zoomOutBtn) {
        zoomOutBtn.addEventListener("click", () => {
            svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.3);
        });
    }

    // --- EXPORT LOGIC ---
    const exportBtn = document.getElementById("export-view-btn");
    const exportMenu = document.getElementById("export-menu");
    
    if (exportBtn) {
        exportBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            exportMenu.classList.toggle("active");
        });
        document.addEventListener("click", () => exportMenu.classList.remove("active"));
    }

    window.exportGraph = function(type) {
        const svgEl = document.getElementById("graph");
        const serializer = new XMLSerializer();
        
        // Clone per non sporcare l'originale
        const clone = svgEl.cloneNode(true);
        
        // Includiamo gli stili CSS necessari per il rendering corretto
        const style = document.createElement("style");
        style.textContent = `
            .node { stroke-width: 2px; }
            .link { stroke: #bbb; }
            .node-label { font-family: sans-serif; font-size: 10px; fill: #444; }
            .hull { stroke-width: 1px; fill-opacity: 0.25; }
        `;
        clone.prepend(style);

        const svgData = serializer.serializeToString(clone);
        const fileName = `knowledge-graph-${new Date().getTime()}`;

        if (type === 'svg') {
            const blob = new Blob([svgData], {type: "image/svg+xml;charset=utf-8"});
            const url = URL.createObjectURL(blob);
            download(url, `${fileName}.svg`);
        } else {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            const img = new Image();
            const svgBlob = new Blob([svgData], {type: "image/svg+xml;charset=utf-8"});
            const url = URL.createObjectURL(svgBlob);

            img.onload = () => {
                canvas.width = width;
                canvas.height = height;
                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                download(canvas.toDataURL("image/png"), `${fileName}.png`);
                URL.revokeObjectURL(url);
            };
            img.src = url;
        }
    };

    function download(url, name) {
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // Avvia il tutorial dopo che la simulazione ha fatto i primi calcoli
    setTimeout(() => {
        updateTutorial();
        interactive = true;
    }, 500); // Attendi 500ms (abbastanza per 30 tick a 60FPS)

    tutorialNext.addEventListener("click", () => {
        if (currentStep >= tutorialSteps.length - 1) {
            endTutorial();
        } else {
            currentStep++;
            updateTutorial();
        }
    });

    tutorialBack.addEventListener("click", () => {
        if (currentStep > 0) {
            currentStep--;
            updateTutorial();
        }
    });

    tutorialSkip.addEventListener("click", () => {
        endTutorial();
    });

    tutorialToggle.addEventListener("click", () => {
        tutorialSidebar.classList.remove('tutorial-closed');
        tutorialToggle.style.display = "none";
        depthNav.classList.add('nav-hidden'); // Nascondi navbar
        const timelinePanel = document.getElementById("timeline-panel");
        if (timelinePanel) timelinePanel.classList.add('nav-hidden'); // Nascondi timeline
        const searchPanel = document.getElementById("search-panel");
        if (searchPanel) searchPanel.classList.add('nav-hidden'); // Nascondi search
        const minimapContainer = document.getElementById("minimap-container");
        if (minimapContainer) minimapContainer.classList.add('nav-hidden'); // Nascondi minimap
        const resetViewContainer = document.getElementById("reset-view-container");
        if (resetViewContainer) resetViewContainer.classList.add('nav-hidden'); // Nascondi reset view
        const exportViewContainer = document.getElementById("export-view-container");
        if (exportViewContainer) exportViewContainer.classList.add('nav-hidden'); // Nascondi export
        const zoomInContainer = document.getElementById("zoom-in-container");
        if (zoomInContainer) zoomInContainer.classList.add('nav-hidden'); // Nascondi zoom in
        const zoomOutContainer = document.getElementById("zoom-out-container");
        if (zoomOutContainer) zoomOutContainer.classList.add('nav-hidden'); // Nascondi zoom out
        currentStep = 0;
        updateTutorial();
        collapseInfoPanel();
        updateSimulationCenter(true);
    });

    // --- TIME PLAYER LOGIC ---
    const playBtn = document.getElementById("play-btn");
    const timeSlider = document.getElementById("time-slider");
    const dateDisplay = document.getElementById("time-date");
    
    // Create cursor element dynamically
    let timelineCursor = document.getElementById("timeline-cursor");
    if (!timelineCursor && timeSlider) {
        timelineCursor = document.createElement("div");
        timelineCursor.id = "timeline-cursor";
        timeSlider.parentNode.insertBefore(timelineCursor, timeSlider);
    }

    if (playBtn && timeSlider && dateDisplay) {
        // Configura slider con il dominio temporale
        if (timeDomain[0] !== timeDomain[1]) {
            timeSlider.min = timeDomain[0];
            timeSlider.max = timeDomain[1];
            timeSlider.value = timeDomain[1];
        } else {
            // Se non ci sono date, disabilita
            playBtn.disabled = true;
            timeSlider.disabled = true;
        }

        function formatTime(ts) {
            if (!ts || ts === 0) return "No Date";
            return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }

        function updateTimeUI() {
            dateDisplay.innerText = formatTime(currentTime);
            timeSlider.value = currentTime;
            
            // Calculate percentage for progress bar and cursor
            const min = parseFloat(timeSlider.min);
            const max = parseFloat(timeSlider.max);
            const val = parseFloat(timeSlider.value);
            const ratio = (val - min) / (max - min);
            const percentage = ratio * 100;

            // Update Progress Bar (Background Gradient)
            timeSlider.style.background = `linear-gradient(to right, #007AFF 0%, #007AFF ${percentage}%, #e0e0e0 ${percentage}%, #e0e0e0 100%)`;

            // Update Cursor Position (Align with thumb center: 12px thumb width -> 6px offset)
            timelineCursor.style.display = "block";
            timelineCursor.style.left = `calc(${percentage}% + ${6 - 12 * ratio}px)`;
        }

        function setTime(ts) {
            isTimelineUpdate = true;
            currentTime = parseInt(ts);
            updateTimeUI();
            updateGraphDepth(currentDepthLevel, true); // Aggiorna visualizzazione con nuovo tempo
            if (simulation) {
                simulation.alpha(0.2).restart(); // Leggero riavvio della simulazione
            }
            isTimelineUpdate = false;
        }

        timeSlider.addEventListener("input", (e) => {
            setTime(e.target.value);
            if (isPlaying) stopPlay();
        });

        function startPlay() {
            if (currentTime >= timeDomain[1]) currentTime = timeDomain[0]; // Riavvia se alla fine
            isPlaying = true;
            playBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="6" height="6" fill="currentColor">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"></path>
                </svg>
            `; // Pause icon

            const step = (timeDomain[1] - timeDomain[0]) / (animationDuration / 50); // step per 50ms interval

            playInterval = setInterval(() => {
                currentTime += step;
                if (currentTime >= timeDomain[1]) {
                    currentTime = timeDomain[1];
                    stopPlay();
                }
                setTime(currentTime);
            }, 50);
        }

        function stopPlay() {
            isPlaying = false;
            playBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
                    <path d="M5 3l14 9-14 9V3z"></path>
                </svg>
            `;
            clearInterval(playInterval);
        }

        playBtn.addEventListener("click", () => {
            if (isPlaying) stopPlay();
            else startPlay();
        });

        updateTimeUI(); // Mostra data iniziale
    }

    // --- TIMELINE ACTIVITY CHART ---
    // Disegna il grafico a "montagna" sopra lo slider
    function drawTimelineChart() {
        const container = document.getElementById("timeline-chart");
        if (!container || timeDomain[0] === timeDomain[1]) return;

        // Dimensioni contenitore
        const w = container.clientWidth;
        const h = container.clientHeight;

        // Pulisci eventuale SVG precedente
        container.innerHTML = "";

        const chartSvg = d3.select(container).append("svg")
            .attr("width", w)
            .attr("height", h)
            .attr("viewBox", `0 0 ${w} ${h}`)
            .attr("preserveAspectRatio", "none");

        // Crea i bin temporali (istogramma)
        const binGenerator = d3.bin()
            .value(d => d.timestamp)
            .domain(timeDomain)
            .thresholds(40); // Numero di intervalli

        const bins = binGenerator(nodes.filter(n => n.timestamp));

        // Range padded by 6px to align perfectly with the slider thumb (12px width)
        const x = d3.scaleLinear().domain(timeDomain).range([6, w - 6]);
        const y = d3.scaleSqrt().domain([0, d3.max(bins, d => d.length)]).range([h, 2]); // ScaleSqrt rende visibili anche i singoli nodi

        // Per un look a step tecnico, aggiungiamo un punto finale fittizio per chiudere il grafico a zero
        const stepData = [...bins, { x0: bins[bins.length - 1].x1, length: 0 }];

        const area = d3.area()
            .curve(d3.curveStepAfter) // Trasforma la curva in gradini tecnici
            .x(d => x(d.x0)) // Allinea l'inizio dello step al timestamp corretto
            .y0(h)
            .y1(d => y(d.length));

        chartSvg.append("path")
            .datum(stepData)
            .attr("fill", "#007bff93") // Colore d'accento (Blu Elettrico)
            .attr("d", area)
            .attr("opacity", 1);
    }

    // Disegna il grafico dopo aver calcolato il dominio temporale
    setTimeout(drawTimelineChart, 100);

    // --- SEARCH BAR LOGIC ---
    const searchInput = document.getElementById("search-input");
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            const term = e.target.value.toLowerCase().trim();
            if (!term) {
                resetHighlight();
                return;
            }

            const filterFn = (d) => {
                const title = (d.detail__title || "").toLowerCase();
                const text = (d.detail__text || "").toLowerCase();
                const val = (d.detail__value || "").toLowerCase(); // per le keyword
                const type = (titleAccessorGlobal(d) || "").toLowerCase();
                
                // Cerca nel titolo, testo, valore (entity) o tipo
                return title.includes(term) || text.includes(term) || val.includes(term) || type.includes(term);
            };

            highlightNodes(filterFn);
        });
    }

    updateTutorial();

}).catch(error => {
    console.error("Error loading CSV files:", error);
    alert("Error loading KG_nodes.csv or KG_edges.csv. Check the filenames and paths.");
});
