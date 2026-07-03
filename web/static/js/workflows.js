(function () {
    'use strict';

    let workflows = [];
    let currentWorkflowId = '';
    let cy = null;
    let nodeSeq = 1;
    let edgeSeq = 1;
    let connectMode = false;
    let connectSourceId = '';
    let selectedElement = null;
    let workflowToolOptions = [];
    let workflowToolsLoaded = false;

    const NODE_LABELS = {
        start: '开始',
        tool: '工具',
        agent: 'Agent',
        condition: '条件',
        hitl: '审批',
        output: '输出',
        end: '结束'
    };

    const AGENT_MODES = ['eino_single', 'deep', 'plan_execute', 'supervisor'];

    function esc(text) {
        if (typeof escapeHtml === 'function') return escapeHtml(text == null ? '' : String(text));
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function defaultGraph() {
        return { nodes: [], edges: [], config: {} };
    }

    function defaultConfigForType(type) {
        switch (type) {
            case 'start':
                return { input_keys: 'message, conversationId, projectId' };
            case 'tool':
                return { tool_name: '', arguments: '{}', timeout_seconds: '' };
            case 'agent':
                return { agent_mode: 'eino_single', input_source: '{{previous.output}}', instruction: '', output_key: 'agent_result' };
            case 'condition':
                return { expression: '{{previous.output}} != ""' };
            case 'hitl':
                return { prompt: '请审批该步骤是否继续执行', reviewer: 'human' };
            case 'output':
                return { output_key: 'result', source: '{{previous.output}}' };
            case 'end':
                return { result_template: '{{outputs.result}}' };
            default:
                return {};
        }
    }

    function configWithDefaults(type, config) {
        return Object.assign(defaultConfigForType(type), config && typeof config === 'object' ? config : {});
    }

    function parseGraph(raw) {
        if (!raw) return defaultGraph();
        let graph = raw;
        if (typeof raw === 'string') {
            try {
                graph = JSON.parse(raw);
            } catch (_) {
                return defaultGraph();
            }
        }
        return {
            nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
            edges: Array.isArray(graph.edges) ? graph.edges : [],
            config: graph.config && typeof graph.config === 'object' ? graph.config : {}
        };
    }

    function graphToElements(graph) {
        const nodes = (graph.nodes || []).map((node, index) => ({
            group: 'nodes',
            data: {
                id: node.id || `node-${index + 1}`,
                label: node.label || NODE_LABELS[node.type] || node.id || `节点 ${index + 1}`,
                type: node.type || 'tool',
                config: configWithDefaults(node.type || 'tool', node.config)
            },
            position: node.position || { x: 120 + index * 80, y: 120 + index * 40 }
        }));
        const edges = (graph.edges || []).map((edge, index) => ({
            group: 'edges',
            data: {
                id: edge.id || `edge-${index + 1}`,
                source: edge.source,
                target: edge.target,
                label: edge.label || '',
                config: edge.config && typeof edge.config === 'object' ? edge.config : {}
            }
        })).filter(edge => edge.data.source && edge.data.target);
        return nodes.concat(edges);
    }

    function elementsToGraph() {
        if (!cy) return defaultGraph();
        return {
            nodes: cy.nodes().map(node => ({
                id: node.id(),
                type: node.data('type') || 'tool',
                label: node.data('label') || '',
                position: node.position(),
                config: node.data('config') || {}
            })),
            edges: cy.edges().map(edge => ({
                id: edge.id(),
                source: edge.source().id(),
                target: edge.target().id(),
                label: edge.data('label') || '',
                config: edge.data('config') || {}
            })),
            config: { schema_version: 1 }
        };
    }

    function updateEmptyState() {
        const empty = document.getElementById('workflow-canvas-empty');
        if (!empty || !cy) return;
        empty.style.display = cy.nodes().length ? 'none' : 'flex';
    }

    function initCy() {
        const container = document.getElementById('workflow-canvas');
        if (!container || typeof cytoscape !== 'function') return;
        if (cy) {
            cy.resize();
            return;
        }
        cy = cytoscape({
            container,
            elements: [],
            wheelSensitivity: 0.18,
            style: [
                {
                    selector: 'node',
                    style: {
                        'shape': 'round-rectangle',
                        'width': 150,
                        'height': 52,
                        'background-color': '#1d4ed8',
                        'border-width': 1,
                        'border-color': '#60a5fa',
                        'label': 'data(label)',
                        'color': '#e5edff',
                        'font-size': 13,
                        'font-weight': 700,
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'text-wrap': 'wrap',
                        'text-max-width': 132
                    }
                },
                { selector: 'node[type="start"]', style: { 'background-color': '#047857', 'border-color': '#34d399' } },
                { selector: 'node[type="tool"]', style: { 'background-color': '#1d4ed8', 'border-color': '#60a5fa' } },
                { selector: 'node[type="agent"]', style: { 'background-color': '#7c3aed', 'border-color': '#c4b5fd' } },
                { selector: 'node[type="condition"]', style: { 'shape': 'diamond', 'background-color': '#b45309', 'border-color': '#fbbf24', 'width': 118, 'height': 86 } },
                { selector: 'node[type="hitl"]', style: { 'background-color': '#0f766e', 'border-color': '#5eead4' } },
                { selector: 'node[type="output"]', style: { 'background-color': '#4338ca', 'border-color': '#a5b4fc' } },
                { selector: 'node[type="end"]', style: { 'background-color': '#be123c', 'border-color': '#fb7185' } },
                {
                    selector: 'edge',
                    style: {
                        'width': 2,
                        'line-color': '#64748b',
                        'target-arrow-color': '#64748b',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'label': 'data(label)',
                        'font-size': 11,
                        'color': '#cbd5e1',
                        'text-background-color': '#0f172a',
                        'text-background-opacity': 0.8,
                        'text-background-padding': 3
                    }
                },
                {
                    selector: ':selected',
                    style: {
                        'border-width': 3,
                        'border-color': '#93c5fd',
                        'line-color': '#93c5fd',
                        'target-arrow-color': '#93c5fd'
                    }
                },
                {
                    selector: '.connect-source',
                    style: {
                        'border-width': 4,
                        'border-color': '#fbbf24'
                    }
                }
            ],
            layout: { name: 'preset' }
        });
        cy.on('tap', 'node', event => {
            if (connectMode) {
                handleConnectTap(event.target);
                return;
            }
            selectWorkflowElement(event.target);
        });
        cy.on('tap', 'edge', event => {
            selectWorkflowElement(event.target);
        });
        cy.on('tap', event => {
            if (event.target === cy) {
                if (connectMode) clearConnectSource();
                selectWorkflowElement(null);
            }
        });
        cy.on('add remove', updateEmptyState);
        document.addEventListener('keydown', event => {
            const active = document.activeElement;
            const editing = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
            if (editing) return;
            if (typeof currentPage !== 'undefined' && currentPage !== 'workflows') return;
            if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                deleteWorkflowSelection();
            }
        });
    }

    async function loadWorkflows(includeDisabled) {
        const response = await apiFetch(`/api/workflows?includeDisabled=${includeDisabled ? 'true' : 'false'}`);
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || '加载工作流失败');
        }
        const data = await response.json();
        workflows = data.workflows || [];
        return workflows;
    }

    async function loadWorkflowTools() {
        if (workflowToolsLoaded) return workflowToolOptions;
        const collected = [];
        const seen = new Set();
        let page = 1;
        let totalPages = 1;
        while (page <= totalPages && page <= 20) {
            const response = await apiFetch(`/api/config/tools?page=${page}&page_size=100`);
            if (!response.ok) break;
            const data = await response.json();
            totalPages = data.total_pages || 1;
            (data.tools || []).forEach(tool => {
                if (!tool || !tool.name) return;
                const key = tool.is_external && tool.external_mcp ? `${tool.external_mcp}::${tool.name}` : tool.name;
                if (seen.has(key)) return;
                seen.add(key);
                collected.push({ key, name: tool.name, enabled: tool.enabled !== false });
            });
            page += 1;
        }
        workflowToolOptions = collected;
        workflowToolsLoaded = true;
        return workflowToolOptions;
    }

    function renderWorkflowList() {
        const list = document.getElementById('workflow-list');
        if (!list) return;
        if (!workflows.length) {
            list.innerHTML = '<div class="empty-state">暂无图编排流程</div>';
            return;
        }
        list.innerHTML = workflows.map(wf => `
            <button type="button" class="workflow-list-item ${wf.id === currentWorkflowId ? 'is-active' : ''}" onclick="selectWorkflow(decodeURIComponent('${encodeURIComponent(wf.id)}'))">
                <span class="workflow-list-title">${esc(wf.name || wf.id)}</span>
                <span class="workflow-list-meta">${esc(wf.id)} · v${wf.version || 1} · ${wf.enabled ? '启用' : '禁用'}</span>
            </button>
        `).join('');
    }

    function nextNodeId(type) {
        while (cy && cy.getElementById(`node-${nodeSeq}`).length) nodeSeq += 1;
        const id = `node-${nodeSeq}`;
        nodeSeq += 1;
        return id;
    }

    function nextEdgeId() {
        while (cy && cy.getElementById(`edge-${edgeSeq}`).length) edgeSeq += 1;
        const id = `edge-${edgeSeq}`;
        edgeSeq += 1;
        return id;
    }

    function resetSequences(graph) {
        nodeSeq = 1;
        edgeSeq = 1;
        (graph.nodes || []).forEach(node => {
            const m = String(node.id || '').match(/^node-(\d+)$/);
            if (m) nodeSeq = Math.max(nodeSeq, Number(m[1]) + 1);
        });
        (graph.edges || []).forEach(edge => {
            const m = String(edge.id || '').match(/^edge-(\d+)$/);
            if (m) edgeSeq = Math.max(edgeSeq, Number(m[1]) + 1);
        });
    }

    function fillWorkflowForm(wf) {
        initCy();
        const idEl = document.getElementById('workflow-id');
        const nameEl = document.getElementById('workflow-name');
        const descEl = document.getElementById('workflow-description');
        const enabledEl = document.getElementById('workflow-enabled');
        if (!idEl || !nameEl || !descEl || !enabledEl || !cy) return;
        idEl.value = wf.id || '';
        idEl.disabled = !!wf.id;
        nameEl.value = wf.name || '';
        descEl.value = wf.description || '';
        enabledEl.checked = wf.enabled !== false;
        currentWorkflowId = wf.id || '';
        const graph = parseGraph(wf.graph_json || wf.graph || defaultGraph());
        resetSequences(graph);
        cy.elements().remove();
        cy.add(graphToElements(graph));
        if (cy.nodes().length) {
            layoutWorkflowGraph(false);
        }
        selectWorkflowElement(null);
        updateEmptyState();
        renderWorkflowList();
        setTimeout(() => cy && cy.resize(), 0);
    }

    function selectWorkflowElement(ele) {
        selectedElement = ele && ele.length ? ele : null;
        const empty = document.getElementById('workflow-property-empty');
        const form = document.getElementById('workflow-property-form');
        const title = document.getElementById('workflow-property-title');
        const deleteBtn = document.getElementById('workflow-property-delete-btn');
        if (!empty || !form) return;
        if (!selectedElement) {
            empty.hidden = false;
            form.hidden = true;
            if (title) title.textContent = '属性';
            if (deleteBtn) deleteBtn.hidden = true;
            return;
        }
        cy.elements().unselect();
        selectedElement.select();
        empty.hidden = true;
        form.hidden = false;
        if (title) title.textContent = selectedElement.isNode() ? '节点属性' : '连线属性';
        if (deleteBtn) {
            deleteBtn.hidden = false;
            deleteBtn.textContent = selectedElement.isNode() ? '删除节点' : '删除连线';
        }
        const typeWrap = document.getElementById('workflow-prop-type-wrap');
        const label = document.getElementById('workflow-prop-label');
        const type = document.getElementById('workflow-prop-type');
        label.value = selectedElement.data('label') || '';
        if (selectedElement.isNode()) {
            typeWrap.style.display = '';
            type.value = selectedElement.data('type') || 'tool';
        } else {
            typeWrap.style.display = 'none';
        }
        renderTypedConfig(selectedElement);
        renderCustomFields(stripTypedConfig(selectedElement));
    }

    function typedKeysForType(type) {
        return new Set(Object.keys(defaultConfigForType(type)));
    }

    function stripTypedConfig(ele) {
        const cfg = Object.assign({}, ele.data('config') || {});
        const typed = ele.isNode() ? typedKeysForType(ele.data('type') || 'tool') : new Set(['condition']);
        typed.forEach(key => delete cfg[key]);
        return cfg;
    }

    function typedField(id, label, value, placeholder) {
        return `
            <div class="form-group">
                <label for="${id}">${label}</label>
                <input type="text" id="${id}" class="form-input" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}" oninput="updateWorkflowTypedConfig()">
            </div>
        `;
    }

    function typedTextarea(id, label, value, placeholder) {
        return `
            <div class="form-group">
                <label for="${id}">${label}</label>
                <textarea id="${id}" class="form-input" rows="4" placeholder="${esc(placeholder || '')}" oninput="updateWorkflowTypedConfig()">${esc(value || '')}</textarea>
            </div>
        `;
    }

    function renderTypedConfig(ele) {
        const wrap = document.getElementById('workflow-typed-config');
        if (!wrap || !ele) return;
        const cfg = configWithDefaults(ele.isNode() ? ele.data('type') : 'edge', ele.data('config') || {});
        if (!ele.isNode()) {
            const sourceType = ele.source().data('type') || '';
            const edgeHint = sourceType === 'condition'
                ? '{{previous.matched}} == "true"（是）或 == "false"（否）'
                : '例如: {{previous.output}} == "ok"';
            wrap.innerHTML = `
                ${typedField('workflow-edge-condition', '连线条件', cfg.condition || '', edgeHint)}
                ${sourceType === 'condition' ? '<p class="workflow-config-hint">从条件节点连出的第一条线默认为「是」分支，第二条为「否」分支；也可在此自定义条件。</p>' : ''}
            `;
            return;
        }
        const type = ele.data('type') || 'tool';
        switch (type) {
            case 'start':
                wrap.innerHTML = typedField('workflow-start-input-keys', '输入变量', cfg.input_keys, 'message, projectId');
                break;
            case 'tool':
                wrap.innerHTML = `
                    <div class="form-group">
                        <label for="workflow-tool-name">MCP 工具</label>
                        <select id="workflow-tool-name" onchange="updateWorkflowTypedConfig()">
                            <option value="">请选择工具</option>
                            ${workflowToolOptions.map(tool => `<option value="${esc(tool.key)}" ${tool.key === cfg.tool_name ? 'selected' : ''}>${esc(tool.key)}${tool.enabled ? '' : '（未启用）'}</option>`).join('')}
                        </select>
                    </div>
                    ${typedTextarea('workflow-tool-arguments', '参数模板', cfg.arguments, '{"target":"{{inputs.target}}"}')}
                    ${typedField('workflow-tool-timeout', '超时秒数', cfg.timeout_seconds, '可选')}
                `;
                if (!workflowToolsLoaded) {
                    loadWorkflowTools().then(() => {
                        if (selectedElement === ele) renderTypedConfig(ele);
                    });
                }
                break;
            case 'agent':
                wrap.innerHTML = `
                    <div class="form-group">
                        <label for="workflow-agent-mode">Agent 模式</label>
                        <select id="workflow-agent-mode" onchange="updateWorkflowTypedConfig()">
                            ${AGENT_MODES.map(mode => `<option value="${mode}" ${mode === cfg.agent_mode ? 'selected' : ''}>${mode}</option>`).join('')}
                        </select>
                    </div>
                    ${typedField('workflow-agent-input-source', '输入来源', cfg.input_source, '{{previous.output}}')}
                    ${typedTextarea('workflow-agent-instruction', '节点指令', cfg.instruction, '描述该节点要完成的任务')}
                    ${typedField('workflow-agent-output-key', '输出变量名', cfg.output_key, 'agent_result')}
                `;
                break;
            case 'condition':
                wrap.innerHTML = `
                    ${typedField('workflow-condition-expression', '条件表达式', cfg.expression, '{{previous.output}} != ""')}
                    <p class="workflow-config-hint">节点会计算 matched（true/false），由出边决定分支：第一条线为「是」，第二条为「否」；也可在连线上写 <code>{{previous.matched}} == "true"</code>。</p>
                `;
                break;
            case 'hitl':
                wrap.innerHTML = `
                    ${typedTextarea('workflow-hitl-prompt', '审批提示', cfg.prompt, '请审批是否继续')}
                    <div class="form-group">
                        <label for="workflow-hitl-reviewer">审批方</label>
                        <select id="workflow-hitl-reviewer" onchange="updateWorkflowTypedConfig()">
                            <option value="human" ${cfg.reviewer === 'human' ? 'selected' : ''}>human</option>
                            <option value="audit_agent" ${cfg.reviewer === 'audit_agent' ? 'selected' : ''}>audit_agent</option>
                        </select>
                    </div>
                `;
                break;
            case 'output':
                wrap.innerHTML = `
                    ${typedField('workflow-output-key', '输出变量名', cfg.output_key, 'result')}
                    ${typedField('workflow-output-source', '变量来源', cfg.source, '{{previous.output}}')}
                `;
                break;
            case 'end':
                wrap.innerHTML = typedTextarea('workflow-end-template', '结束摘要模板', cfg.result_template, '{{outputs.result}}');
                break;
            default:
                wrap.innerHTML = '';
        }
    }

    function renderCustomFields(config) {
        const wrap = document.getElementById('workflow-custom-fields');
        if (!wrap) return;
        const entries = Object.entries(config || {});
        if (!entries.length) {
            wrap.innerHTML = '<div class="workflow-property-empty workflow-property-empty--compact">暂无自定义字段</div>';
            return;
        }
        wrap.innerHTML = entries.map(([key, value], index) => `
            <div class="workflow-custom-field" data-index="${index}">
                <input type="text" value="${esc(key)}" data-field-key oninput="updateWorkflowCustomFields()">
                <input type="text" value="${esc(String(value == null ? '' : value))}" data-field-value oninput="updateWorkflowCustomFields()">
                <button type="button" onclick="removeWorkflowCustomField(${index})">×</button>
            </div>
        `).join('');
    }

    function readCustomFields() {
        const out = {};
        document.querySelectorAll('#workflow-custom-fields .workflow-custom-field').forEach(row => {
            const key = row.querySelector('[data-field-key]').value.trim();
            const value = row.querySelector('[data-field-value]').value;
            if (key) out[key] = value;
        });
        return out;
    }

    function readTypedConfig(ele) {
        if (!ele) return {};
        if (!ele.isNode()) {
            return { condition: (document.getElementById('workflow-edge-condition') || {}).value || '' };
        }
        const type = ele.data('type') || 'tool';
        switch (type) {
            case 'start':
                return { input_keys: (document.getElementById('workflow-start-input-keys') || {}).value || '' };
            case 'tool':
                return {
                    tool_name: (document.getElementById('workflow-tool-name') || {}).value || '',
                    arguments: (document.getElementById('workflow-tool-arguments') || {}).value || '{}',
                    timeout_seconds: (document.getElementById('workflow-tool-timeout') || {}).value || ''
                };
            case 'agent':
                return {
                    agent_mode: (document.getElementById('workflow-agent-mode') || {}).value || 'eino_single',
                    input_source: (document.getElementById('workflow-agent-input-source') || {}).value || '{{previous.output}}',
                    instruction: (document.getElementById('workflow-agent-instruction') || {}).value || '',
                    output_key: (document.getElementById('workflow-agent-output-key') || {}).value || 'agent_result'
                };
            case 'condition':
                return { expression: (document.getElementById('workflow-condition-expression') || {}).value || '' };
            case 'hitl':
                return {
                    prompt: (document.getElementById('workflow-hitl-prompt') || {}).value || '',
                    reviewer: (document.getElementById('workflow-hitl-reviewer') || {}).value || 'human'
                };
            case 'output':
                return {
                    output_key: (document.getElementById('workflow-output-key') || {}).value || 'result',
                    source: (document.getElementById('workflow-output-source') || {}).value || ''
                };
            case 'end':
                return { result_template: (document.getElementById('workflow-end-template') || {}).value || '' };
            default:
                return {};
        }
    }

    function mergeVisibleConfig() {
        if (!selectedElement) return;
        selectedElement.data('config', Object.assign({}, readCustomFields(), readTypedConfig(selectedElement)));
    }

    function handleConnectTap(node) {
        if (!connectSourceId) {
            connectSourceId = node.id();
            node.addClass('connect-source');
            return;
        }
        if (connectSourceId === node.id()) {
            clearConnectSource();
            return;
        }
        const duplicate = cy.edges().some(edge => edge.source().id() === connectSourceId && edge.target().id() === node.id());
        if (duplicate) {
            if (typeof showNotification === 'function') {
                showNotification('这两个节点之间已经有连线', 'warning');
            }
            clearConnectSource();
            return;
        }
        const sourceNode = cy.getElementById(connectSourceId);
        const sourceType = sourceNode.data('type') || '';
        let edgeLabel = '';
        let edgeConfig = {};
        if (sourceType === 'condition') {
            const siblingCount = cy.edges().filter(edge => edge.source().id() === connectSourceId).length;
            if (siblingCount === 0) {
                edgeLabel = '是';
                edgeConfig = { condition: '{{previous.matched}} == "true"', branch: 'true' };
            } else if (siblingCount === 1) {
                edgeLabel = '否';
                edgeConfig = { condition: '{{previous.matched}} == "false"', branch: 'false' };
            } else {
                edgeConfig = { condition: '' };
            }
        }
        cy.add({
            group: 'edges',
            data: {
                id: nextEdgeId(),
                source: connectSourceId,
                target: node.id(),
                label: edgeLabel,
                config: edgeConfig
            }
        });
        clearConnectSource();
    }

    function clearConnectSource() {
        if (cy) cy.nodes().removeClass('connect-source');
        connectSourceId = '';
    }

    function addNode(type, position) {
        initCy();
        if (!cy) return;
        const node = cy.add({
            group: 'nodes',
            data: {
                id: nextNodeId(type),
                type,
                label: NODE_LABELS[type] || '节点',
                config: defaultConfigForType(type)
            },
            position: position || { x: 180 + cy.nodes().length * 28, y: 160 + cy.nodes().length * 28 }
        });
        selectWorkflowElement(node);
        updateEmptyState();
    }

    window.refreshWorkflows = async function () {
        initCy();
        const list = document.getElementById('workflow-list');
        if (list) list.innerHTML = '<div class="loading-spinner">加载中...</div>';
        try {
            await loadWorkflows(true);
            renderWorkflowList();
            if (!currentWorkflowId && workflows.length) {
                fillWorkflowForm(workflows[0]);
            } else if (!workflows.length) {
                newWorkflowDraft();
            }
        } catch (error) {
            if (list) list.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
            if (typeof showNotification === 'function') showNotification(error.message, 'error');
        }
    };

    window.newWorkflowDraft = function () {
        fillWorkflowForm({
            id: '',
            name: '',
            description: '',
            enabled: true,
            graph_json: defaultGraph()
        });
    };

    window.selectWorkflow = function (id) {
        const wf = workflows.find(item => item.id === id);
        if (wf) fillWorkflowForm(wf);
    };

    function validateWorkflowGraph(graph) {
        const errors = [];
        const nodes = graph.nodes || [];
        const edges = graph.edges || [];
        const ids = new Set(nodes.map(node => node.id));
        const starts = nodes.filter(node => node.type === 'start');
        const outputs = nodes.filter(node => node.type === 'output');
        if (!starts.length) errors.push('至少需要一个开始节点');
        if (!outputs.length) errors.push('至少需要一个输出节点');
        edges.forEach(edge => {
            if (edge.source === edge.target) errors.push(`连线 ${edge.id} 不能指向自身`);
            if (!ids.has(edge.source)) errors.push(`连线 ${edge.id} 的源节点不存在`);
            if (!ids.has(edge.target)) errors.push(`连线 ${edge.id} 的目标节点不存在`);
        });
        starts.forEach(node => {
            if (edges.some(edge => edge.target === node.id)) errors.push(`开始节点 ${node.label || node.id} 不应有入边`);
        });
        outputs.forEach(node => {
            if (edges.some(edge => edge.source === node.id)) errors.push(`输出节点 ${node.label || node.id} 不应有出边`);
        });
        nodes.filter(node => node.type === 'tool').forEach(node => {
            if (!String((node.config || {}).tool_name || '').trim()) {
                errors.push(`工具节点 ${node.label || node.id} 需要选择 MCP 工具`);
            }
        });
        nodes.filter(node => node.type === 'condition').forEach(node => {
            if (!String((node.config || {}).expression || '').trim()) {
                errors.push(`条件节点 ${node.label || node.id} 需要条件表达式`);
            }
            const outEdges = edges.filter(edge => edge.source === node.id);
            if (outEdges.length === 0) {
                errors.push(`条件节点 ${node.label || node.id} 至少需要一条出边（是/否分支）`);
            } else if (outEdges.length > 2) {
                errors.push(`条件节点 ${node.label || node.id} 建议最多两条出边（是/否）；第三条及以后需配置连线条件`);
            }
        });
        nodes.filter(node => node.type === 'output').forEach(node => {
            if (!String((node.config || {}).output_key || '').trim()) {
                errors.push(`输出节点 ${node.label || node.id} 需要输出变量名`);
            }
        });
        return errors;
    }

    window.saveWorkflowDraft = async function () {
        initCy();
        const id = document.getElementById('workflow-id').value.trim();
        const name = document.getElementById('workflow-name').value.trim();
        const description = document.getElementById('workflow-description').value.trim();
        const enabled = document.getElementById('workflow-enabled').checked;
        if (!id || !name) {
            showNotification('工作流 ID 和名称不能为空', 'error');
            return;
        }
        const graph = elementsToGraph();
        const errors = validateWorkflowGraph(graph);
        if (errors.length) {
            showNotification(errors.slice(0, 4).join('；'), 'error');
            return;
        }
        const method = currentWorkflowId ? 'PUT' : 'POST';
        const url = currentWorkflowId ? `/api/workflows/${encodeURIComponent(currentWorkflowId)}` : '/api/workflows';
        const response = await apiFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, name, description, enabled, graph })
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            showNotification(err.error || '保存工作流失败', 'error');
            return;
        }
        const data = await response.json();
        currentWorkflowId = data.workflow && data.workflow.id ? data.workflow.id : id;
        showNotification('工作流已保存', 'success');
        await refreshWorkflows();
        if (typeof loadWorkflowOptionsForRoleModal === 'function') {
            await loadWorkflowOptionsForRoleModal();
        }
    };

    window.deleteCurrentWorkflow = async function () {
        const id = currentWorkflowId || document.getElementById('workflow-id').value.trim();
        if (!id) {
            showNotification('请选择要删除的工作流', 'warning');
            return;
        }
        if (!confirm(`确定删除工作流 ${id}？`)) return;
        const response = await apiFetch(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            showNotification(err.error || '删除工作流失败', 'error');
            return;
        }
        currentWorkflowId = '';
        showNotification('工作流已删除', 'success');
        newWorkflowDraft();
        await refreshWorkflows();
    };

    window.workflowPaletteDragStart = function (event) {
        const type = event.currentTarget.dataset.nodeType || 'tool';
        event.dataTransfer.setData('application/x-workflow-node', type);
        event.dataTransfer.setData('text/plain', type);
        event.dataTransfer.effectAllowed = 'copy';
    };

    window.workflowCanvasDragOver = function (event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    };

    window.workflowCanvasDrop = function (event) {
        event.preventDefault();
        const type = event.dataTransfer.getData('application/x-workflow-node') || event.dataTransfer.getData('text/plain') || 'tool';
        const rect = document.getElementById('workflow-canvas').getBoundingClientRect();
        const pan = cy.pan();
        const zoom = cy.zoom();
        addNode(type, {
            x: (event.clientX - rect.left - pan.x) / zoom,
            y: (event.clientY - rect.top - pan.y) / zoom
        });
    };

    window.addWorkflowNodeFromPalette = function (type) {
        addNode(type || 'tool');
    };

    window.toggleWorkflowConnectMode = function () {
        connectMode = !connectMode;
        clearConnectSource();
        const btn = document.getElementById('workflow-connect-btn');
        if (btn) {
            btn.classList.toggle('active', connectMode);
            btn.textContent = connectMode ? '连线中' : '连线';
        }
        if (typeof showNotification === 'function') {
            showNotification(connectMode ? '连线模式：依次点击源节点和目标节点' : '已退出连线模式', 'info');
        }
    };

    window.deleteWorkflowSelection = function () {
        if (!cy) return;
        const selected = selectedElement && selectedElement.length ? selectedElement : cy.$(':selected');
        if (!selected.length) return;
        selected.remove();
        selectWorkflowElement(null);
        updateEmptyState();
    };

    window.layoutWorkflowGraph = function (animate) {
        if (!cy || !cy.nodes().length) return;
        cy.layout({
            name: 'breadthfirst',
            directed: true,
            padding: 40,
            spacingFactor: 1.25,
            animate: animate !== false,
            animationDuration: 250
        }).run();
        cy.fit(undefined, 40);
    };

    window.updateWorkflowSelectedProperty = function () {
        if (!selectedElement) return;
        const label = document.getElementById('workflow-prop-label').value.trim();
        selectedElement.data('label', label);
        if (selectedElement.isNode()) {
            const type = document.getElementById('workflow-prop-type').value || 'tool';
            const prevType = selectedElement.data('type') || 'tool';
            selectedElement.data('type', type);
            if (type !== prevType) {
                selectedElement.data('config', defaultConfigForType(type));
                selectedElement.data('label', label || NODE_LABELS[type] || '节点');
                document.getElementById('workflow-prop-label').value = selectedElement.data('label') || '';
                renderTypedConfig(selectedElement);
                renderCustomFields({});
            }
        }
    };

    window.addWorkflowCustomField = function () {
        if (!selectedElement) return;
        const cfg = Object.assign({}, selectedElement.data('config') || {});
        let i = 1;
        while (Object.prototype.hasOwnProperty.call(cfg, `field_${i}`)) i += 1;
        cfg[`field_${i}`] = '';
        selectedElement.data('config', cfg);
        renderCustomFields(cfg);
    };

    window.updateWorkflowCustomFields = function () {
        if (!selectedElement) return;
        mergeVisibleConfig();
    };

    window.updateWorkflowTypedConfig = function () {
        if (!selectedElement) return;
        mergeVisibleConfig();
    };

    window.removeWorkflowCustomField = function (index) {
        if (!selectedElement) return;
        const entries = Object.entries(stripTypedConfig(selectedElement));
        entries.splice(index, 1);
        const next = {};
        entries.forEach(([key, value]) => {
            if (key) next[key] = value;
        });
        selectedElement.data('config', Object.assign({}, next, readTypedConfig(selectedElement)));
        renderCustomFields(next);
    };

    window.loadWorkflowOptionsForRoleModal = async function (selectedId) {
        try {
            await loadWorkflows(true);
        } catch (_) {
            workflows = [];
        }
        const select = document.getElementById('role-workflow-id');
        if (!select) return;
        const current = selectedId !== undefined ? selectedId : select.value;
        select.innerHTML = '<option value="">不绑定流程</option>' + workflows.map(wf => (
            `<option value="${esc(wf.id)}">${esc(wf.name || wf.id)}${wf.enabled ? '' : '（已禁用）'}</option>`
        )).join('');
        select.value = current || '';
    };
})();
