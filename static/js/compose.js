// ---- Compose Post: state & config ----
// composeState.images and composeState.audience are now sent to the server:
// handlePostSubmit() uses multipart/form-data (content + audience + images[])
// when images are attached, matching POST /api/posts on the backend.
const COMPOSE_MAX_CHARS = 1000;
const COMPOSE_MAX_IMAGES = 4;
const COMPOSE_DRAFT_KEY = 'beebo_draft_v1';

let composeState = {
    images: [],       // [{ dataUrl, name }]
    audience: 'Academic'
};
let composeAutosaveTimer = null;

// Called every time the create-post view is shown
function initComposeView() {
    const textarea = document.getElementById('create-post-textarea');
    const errorDiv = document.getElementById('create-post-error');

    errorDiv.classList.add('hidden');
    closeAddMenu();
    closeAudiencePicker();
    closeDiscardDialog();
    resetSubmitButtonState();

    const draft = loadDraft();
    if (draft) {
        textarea.value = draft.content || '';
        composeState.images = draft.images || [];
        composeState.audience = draft.audience || 'Academic';
    } else {
        textarea.value = '';
        composeState.images = [];
        composeState.audience = 'Academic';
    }

    document.getElementById('audience-label').textContent = composeState.audience;
    renderMediaGrid();
    updateMediaToolbarLabel();
    updateCharCounter();
    updatePostButtonState();

    // Autofocus only when starting a fresh post; leave cursor alone when
    // there's nothing typed yet vs. restoring a draft the user may just want to review.
    if (!draft) {
        textarea.focus();
    }
}

// ---- Character counter ----
function updateCharCounter() {
    const textarea = document.getElementById('create-post-textarea');
    const counter = document.getElementById('char-counter');
    const len = textarea.value.length;

    // Only surface the counter once the user is close to the limit —
    // keeps the composer uncluttered for the common short post.
    if (len >= COMPOSE_MAX_CHARS - 100) {
        counter.classList.remove('hidden');
        counter.textContent = `${len}/${COMPOSE_MAX_CHARS}`;
        counter.classList.toggle('text-red-500', len > COMPOSE_MAX_CHARS);
        counter.classList.toggle('text-gray-400', len <= COMPOSE_MAX_CHARS);
    } else {
        counter.classList.add('hidden');
    }
}

function updatePostButtonState() {
    const textarea = document.getElementById('create-post-textarea');
    const submitBtn = document.getElementById('submit-post-btn');
    const len = textarea.value.trim().length;
    const overLimit = textarea.value.length > COMPOSE_MAX_CHARS;
    submitBtn.disabled = len === 0 || overLimit;
    submitBtn.setAttribute('aria-disabled', String(submitBtn.disabled));
}

// ---- Media attach / preview / remove ----
function triggerMediaPicker() {
    closeAddMenu();
    document.getElementById('media-file-input').click();
}

function handleMediaFilesSelected(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // allow re-selecting the same file later

    if (!files.length) return;

    const errorDiv = document.getElementById('create-post-error');
    const remainingSlots = COMPOSE_MAX_IMAGES - composeState.images.length;

    if (remainingSlots <= 0) {
        errorDiv.textContent = `You can attach up to ${COMPOSE_MAX_IMAGES} photos per post.`;
        errorDiv.classList.remove('hidden');
        return;
    }

    const filesToAdd = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
        errorDiv.textContent = `Only ${remainingSlots} more photo${remainingSlots === 1 ? '' : 's'} could be added (max ${COMPOSE_MAX_IMAGES}).`;
        errorDiv.classList.remove('hidden');
    } else {
        errorDiv.classList.add('hidden');
    }

    filesToAdd.forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = e => {
            composeState.images.push({ dataUrl: e.target.result, name: file.name });
            renderMediaGrid();
            updateMediaToolbarLabel();
            scheduleAutosave();
        };
        reader.readAsDataURL(file);
    });
}

function removeMediaImage(index) {
    composeState.images.splice(index, 1);
    renderMediaGrid();
    updateMediaToolbarLabel();
    scheduleAutosave();
}

function renderMediaGrid() {
    const grid = document.getElementById('media-preview-grid');
    if (!composeState.images.length) {
        grid.classList.add('hidden');
        grid.innerHTML = '';
        return;
    }

    grid.classList.remove('hidden');
    grid.innerHTML = composeState.images.map((img, i) => `
<div class="relative aspect-square rounded-xl overflow-hidden bg-gray-100">
<img src="${img.dataUrl}" alt="Attached photo ${i + 1}" class="w-full h-full object-cover"/>
<button type="button" aria-label="Remove photo" class="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors" onclick="removeMediaImage(${i})">
<i class="fa-solid fa-xmark text-xs"></i>
</button>
</div>`).join('');
}

function updateMediaToolbarLabel() {
    const label = document.getElementById('media-toolbar-label');
    const count = composeState.images.length;
    if (count === 0) {
        label.textContent = 'Add media, poll, link...';
        label.classList.add('text-gray-400');
    } else {
        label.textContent = `${count}/${COMPOSE_MAX_IMAGES} photo${count === 1 ? '' : 's'} added — tap to add more`;
        label.classList.remove('text-gray-400');
        label.classList.add('text-gray-600');
    }
}

// ---- "+" add menu popover ----
function toggleAddMenu() {
    const popover = document.getElementById('add-menu-popover');
    const backdrop = document.getElementById('add-menu-backdrop');
    const trigger = document.getElementById('add-menu-trigger');
    const opening = popover.classList.contains('hidden');

    popover.classList.toggle('hidden', !opening);
    backdrop.classList.toggle('hidden', !opening);
    trigger.setAttribute('aria-expanded', String(opening));
}

function closeAddMenu() {
    document.getElementById('add-menu-popover').classList.add('hidden');
    document.getElementById('add-menu-backdrop').classList.add('hidden');
    document.getElementById('add-menu-trigger').setAttribute('aria-expanded', 'false');
}

// ---- Audience / category picker ----
function toggleAudiencePicker() {
    const sheet = document.getElementById('audience-sheet');
    const opening = sheet.classList.contains('hidden');
    if (opening) {
        openAudiencePicker();
    } else {
        closeAudiencePicker();
    }
}

function openAudiencePicker() {
    document.getElementById('audience-sheet').classList.remove('hidden');
    document.getElementById('audience-backdrop').classList.remove('hidden');
    document.getElementById('audience-picker-btn').setAttribute('aria-expanded', 'true');
    document.querySelectorAll('.audience-option').forEach(btn => {
        const isSelected = btn.dataset.value === composeState.audience;
        btn.querySelector('i').classList.toggle('hidden', !isSelected);
        btn.classList.toggle('font-semibold', isSelected);
        btn.classList.toggle('text-brand-red', isSelected);
    });
}

function closeAudiencePicker() {
    document.getElementById('audience-sheet').classList.add('hidden');
    document.getElementById('audience-backdrop').classList.add('hidden');
    document.getElementById('audience-picker-btn').setAttribute('aria-expanded', 'false');
}

function selectAudience(value) {
    composeState.audience = value;
    document.getElementById('audience-label').textContent = value;
    closeAudiencePicker();
    scheduleAutosave();
}

// ---- Autosave / draft persistence (localStorage placeholder;
// see backend prompt for a real /api/drafts endpoint) ----
function scheduleAutosave() {
    clearTimeout(composeAutosaveTimer);
    composeAutosaveTimer = setTimeout(saveDraft, 400);
}

function saveDraft() {
    const textarea = document.getElementById('create-post-textarea');
    const content = textarea.value;

    if (!content.trim() && composeState.images.length === 0) {
        localStorage.removeItem(COMPOSE_DRAFT_KEY);
        return;
    }

    const draft = {
        content,
        images: composeState.images,
        audience: composeState.audience,
        savedAt: Date.now()
    };

    try {
        localStorage.setItem(COMPOSE_DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {
        // Storage quota exceeded (large images) — fail silently, draft simply
        // won't persist. Real media should go to the server, not localStorage.
    }
}

function loadDraft() {
    try {
        const raw = localStorage.getItem(COMPOSE_DRAFT_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function clearDraft() {
    localStorage.removeItem(COMPOSE_DRAFT_KEY);
}

function hasUnsavedComposeContent() {
    const textarea = document.getElementById('create-post-textarea');
    return textarea.value.trim().length > 0 || composeState.images.length > 0;
}

// ---- Close / discard flow ----
function attemptCloseCompose() {
    if (hasUnsavedComposeContent()) {
        openDiscardDialog();
    } else {
        clearDraft();
        showView('feed');
    }
}

function openDiscardDialog() {
    document.getElementById('discard-backdrop').classList.remove('hidden');
    document.getElementById('discard-dialog').classList.remove('hidden');
}

function closeDiscardDialog() {
    document.getElementById('discard-backdrop').classList.add('hidden');
    document.getElementById('discard-dialog').classList.add('hidden');
}

function confirmDiscardPost() {
    clearDraft();
    composeState.images = [];
    composeState.audience = 'Academic';
    closeDiscardDialog();
    showView('feed');
}

function saveDraftAndClose() {
    saveDraft();
    closeDiscardDialog();
    showToast('Draft saved');
    showView('feed');
}

// ---- Toast ----
let toastTimer = null;
function showToast(message) {
    const toast = document.getElementById('app-toast');
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.remove('hidden');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

// ---- Submit button loading state ----
function setSubmitButtonLoading(isLoading) {
    const submitBtn = document.getElementById('submit-post-btn');
    const spinner = document.getElementById('submit-post-spinner');
    const label = document.getElementById('submit-post-label');

    submitBtn.disabled = isLoading;
    submitBtn.setAttribute('aria-busy', String(isLoading));
    spinner.classList.toggle('hidden', !isLoading);
    label.textContent = isLoading ? 'Posting…' : 'Post';
}

function resetSubmitButtonState() {
    setSubmitButtonLoading(false);
}

// Convert a data: URL (as stored in composeState.images) back into a Blob
// so it can be appended to FormData for upload.
function dataUrlToBlob(dataUrl) {
    const [header, base64] = dataUrl.split(',');
    const mimeMatch = header.match(/data:(.*?);base64/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}

// Handle the "Post" button in create-post-view
async function handlePostSubmit() {
    const textarea = document.getElementById('create-post-textarea');
    const errorDiv = document.getElementById('create-post-error');
    const content = textarea.value.trim();

    errorDiv.classList.add('hidden');

    if (!content) {
        errorDiv.textContent = 'Post cannot be empty.';
        errorDiv.classList.remove('hidden');
        return;
    }

    if (content.length > COMPOSE_MAX_CHARS) {
        errorDiv.textContent = `Your post is over the ${COMPOSE_MAX_CHARS}-character limit.`;
        errorDiv.classList.remove('hidden');
        return;
    }

    setSubmitButtonLoading(true);

    try {
        const hasImages = composeState.images.length > 0;
        let response;

        if (hasImages) {
            // Multipart upload — backend expects `content`, `audience`, and
            // one or more `images` file fields on this path.
            const formData = new FormData();
            formData.append('content', content);
            formData.append('audience', composeState.audience);
            composeState.images.forEach((img, i) => {
                formData.append('images', dataUrlToBlob(img.dataUrl), img.name || `photo-${i}.png`);
            });

            response = await apiFetch('/api/posts', {
                method: 'POST',
                body: formData
            });
        } else {
            // No images — keep the original JSON path.
            response = await apiFetch('/api/posts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ content, audience: composeState.audience })
            });
        }

        const data = await response.json();

        if (response.ok) {
            textarea.value = '';
            composeState.images = [];
            composeState.audience = 'Academic';
            clearDraft();
            resetSubmitButtonState();
            showView('feed');
            showToast('Post published');
        } else {
            setSubmitButtonLoading(false);
            errorDiv.textContent = data.error || 'Failed to create post. Please try again.';
            errorDiv.classList.remove('hidden');
        }
    } catch (error) {
        setSubmitButtonLoading(false);
        errorDiv.textContent = 'Network error — check your connection and try again.';
        errorDiv.classList.remove('hidden');
    }
}

// Wire up textarea listeners once the DOM is ready
(function initComposeTextareaListeners() {
    const textarea = document.getElementById('create-post-textarea');
    if (!textarea) return;

    textarea.addEventListener('input', () => {
        updateCharCounter();
        updatePostButtonState();
        scheduleAutosave();
    });

    // Cmd/Ctrl+Enter submits, matching common composer shortcuts
    textarea.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!document.getElementById('submit-post-btn').disabled) {
                handlePostSubmit();
            }
        }
    });
})();
