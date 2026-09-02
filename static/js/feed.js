// ---- Dynamic Feed Posts ----

// Escape user content before inserting into innerHTML or into a
// double-quoted HTML attribute. div.textContent/innerHTML only escapes
// &, <, > — it leaves " and ' untouched, which corrupts any attribute
// value containing them (e.g. data-post-images="${JSON.stringify(...)}"
// is full of double quotes and gets truncated at the first one).
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Compute a human friendly "X ago" string from a SQLite timestamp
// (format: "YYYY-MM-DD HH:MM:SS", assumed UTC since it's CURRENT_TIMESTAMP)
function formatTimeAgo(createdAt) {
    if (!createdAt) return '';
    const isoLike = createdAt.replace(' ', 'T') + 'Z';
    const then = new Date(isoLike);
    if (isNaN(then.getTime())) return '';

    const diffMs = Date.now() - then.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

// Post timestamp formatter: compact relative time ("2h", "8h", "23h") for
// posts under 24h old, exact "YYYY.MM.DD" date (post's own creation date)
// for posts 24h or older. Used everywhere a post's own timestamp is shown
// (feed card + Post & Comments overlay header) — distinct from
// formatTimeAgo, which still drives comment timestamps.
function formatPostTime(createdAt) {
    if (!createdAt) return '';
    const isoLike = createdAt.replace(' ', 'T') + 'Z';
    const then = new Date(isoLike);
    if (isNaN(then.getTime())) return '';

    const diffMs = Date.now() - then.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m`;

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h`;

    const year = then.getFullYear();
    const month = String(then.getMonth() + 1).padStart(2, '0');
    const day = String(then.getDate()).padStart(2, '0');
    return `${year}.${month}.${day}`;
}

// If a post image fails to load (e.g. it was requested a moment before
// the upload fully settled on disk), retry a few times with backoff and
// a cache-busting param instead of leaving the broken-image icon up
// forever. Stops retrying after 3 attempts.
function handlePostImageError(imgEl) {
    const attempts = parseInt(imgEl.dataset.retryCount || '0', 10);
    if (attempts >= 3) return;
    imgEl.dataset.retryCount = String(attempts + 1);
    const baseSrc = imgEl.dataset.baseSrc || imgEl.getAttribute('src');
    imgEl.dataset.baseSrc = baseSrc;
    setTimeout(() => {
        imgEl.src = `${baseSrc}${baseSrc.includes('?') ? '&' : '?'}retry=${Date.now()}`;
    }, 500 * (attempts + 1));
}

// Build image grid markup for a post's attached images (0-4), matching the
// reference card's large rounded media block, placed between the header and
// the post text.
function buildPostImagesHtml(images) {
    if (!images || images.length === 0) return '';

    const count = images.length;
    let gridClass = 'grid-cols-1';
    if (count === 2) gridClass = 'grid-cols-2';
    if (count === 3) gridClass = 'grid-cols-2 grid-rows-2';
    if (count >= 4) gridClass = 'grid-cols-2 grid-rows-2';

    const imgEls = images.map((url, i) => {
        const spanClass = (count === 3 && i === 0) ? 'row-span-2' : '';
        const heightClass = count === 1 ? 'max-h-[420px]' : 'h-full';
        return `<img src="${escapeHtml(url)}" alt="Post attachment" loading="lazy" onerror="handlePostImageError(this)" class="w-full ${heightClass} object-cover ${spanClass}"/>`;
    }).join('');

    return `<div class="grid ${gridClass} gap-0.5 rounded-2xl overflow-hidden mb-3 bg-gray-100">${imgEls}</div>`;
}

// Build the markup for a single post row in the flat, full-width timeline
// (border-b divider between rows, no per-post rounding/shadow/background
// card treatment) - shared by the main feed, own-profile Posts tab, and
// another user's profile Posts tab (see postCardContainerIds in
// comments.js). No badge/tag element for untagged posts.
function buildPostCardHtml(post) {
    const avatarUrl = post.author_avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(post.author_handle)}`;
    const authorName = escapeHtml(post.author_name);
    const authorHandle = escapeHtml(post.author_handle);
    const content = escapeHtml(post.content);
    const timeAgo = escapeHtml(formatPostTime(post.created_at));
    const likedTextColor = post.liked_by_user ? 'text-brand-red' : 'text-gray-500';

    const isLong = post.content.length > 220;
    const bodyClass = isLong ? 'post-content-clamped' : '';
    const imagesHtml = buildPostImagesHtml(post.images);

    return `
<article class="bg-white px-4 py-4 border-b border-gray-100 last:border-b-0" data-post-id="${post.id}" data-post-user-id="${escapeHtml(String(post.user_id))}" data-post-author-name="${authorName}" data-post-author-handle="${authorHandle}" data-post-author-avatar="${escapeHtml(post.author_avatar || '')}" data-post-content="${content}" data-post-created-at="${escapeHtml(post.created_at)}" data-post-like-count="${post.like_count}" data-post-comment-count="${post.comment_count}" data-post-liked="${post.liked_by_user}" data-post-images="${escapeHtml(JSON.stringify(post.images || []))}">
<div class="flex justify-between items-start mb-3">
<div class="flex items-center space-x-3 cursor-pointer" onclick="openProfileFromPostCard(this)">
<img alt="${authorName}" class="w-11 h-11 rounded-full bg-gray-200 border border-gray-100 object-cover" src="${avatarUrl}"/>
<div>
<h2 class="font-bold text-gray-900 text-[15px] leading-tight">${authorName}</h2>
<p class="text-gray-400 text-[13px] leading-tight">${timeAgo}</p>
</div>
</div>
<button class="post-menu-btn text-gray-400 hover:text-gray-600 p-1 -mr-1 -mt-1" aria-label="More options">
<svg class="w-4 h-4" fill="currentColor" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
<path d="M12 6a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4z"></path>
</svg>
</button>
</div>
${imagesHtml}
<p class="text-gray-800 text-[15px] mb-4 leading-relaxed post-content ${bodyClass}">${content}${isLong ? ' <button class="read-more-btn text-gray-400 font-medium">Read more</button>' : ''}</p>
<div class="flex items-center text-gray-500">
<button class="like-btn flex items-center space-x-2 hover:text-gray-700 transition-colors mr-6" data-post-id="${post.id}" data-liked="${post.liked_by_user}">
<span class="like-icon-wrapper">
	<svg class="w-5 h-5 ${likedTextColor} heart-outline" fill="none" stroke="currentColor" stroke-width="1.5" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
	<path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" stroke-linecap="round" stroke-linejoin="round"></path>
	</svg>
	<svg class="w-5 h-5 text-brand-red heart-filled absolute inset-0" fill="currentColor" stroke="none" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
	<path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"></path>
	</svg>
</span>
<span class="text-sm like-count ${likedTextColor}">${post.like_count}</span>
</button>
<button class="comment-btn flex items-center space-x-2 hover:text-gray-700">
<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.5" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
<path d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" stroke-linecap="round" stroke-linejoin="round"></path>
</svg>
<span class="text-sm comment-count">${post.comment_count}</span>
</button>
</div>
</article>`;
}

// Render an array of posts into the feed container, or an empty state
function renderFeedPosts(posts) {
    const container = document.getElementById('feed-posts-container');
    if (!container) return;

    if (!posts || posts.length === 0) {
        container.innerHTML = `
<div class="flex items-center justify-center h-full min-h-[50vh] text-gray-400 text-sm">
No posts yet
</div>`;
        return;
    }

    container.innerHTML = posts.map(buildPostCardHtml).join('');
}

// Feed pagination state. Reset on every fresh load (see fetchAndRenderPosts).
// GET /api/posts now returns {posts, next_cursor} instead of a bare array -
// next_cursor is the id to pass back to fetch the next page, or null when
// there are no more posts.
let feedNextCursor = null;
let feedIsLoadingMore = false;
let feedExhausted = false;
const FEED_PAGE_SIZE = 20;
const FEED_SCROLL_THRESHOLD_PX = 300;

// Fetch the first page of posts from the backend and render them into the
// feed, resetting pagination state. Call this whenever the feed is
// (re)opened, not when appending more posts (see loadMoreFeedPosts).
async function fetchAndRenderPosts() {
    feedNextCursor = null;
    feedIsLoadingMore = false;
    feedExhausted = false;

    try {
        const response = await fetch(`/api/posts?limit=${FEED_PAGE_SIZE}`);
        if (!response.ok) {
            throw new Error('Failed to load posts');
        }
        const data = await response.json();
        renderFeedPosts(data.posts);
        feedNextCursor = data.next_cursor;
        feedExhausted = data.next_cursor === null;
    } catch (error) {
        const container = document.getElementById('feed-posts-container');
        if (container) {
            container.innerHTML = `
<div class="flex items-center justify-center h-full min-h-[50vh] text-gray-400 text-sm">
No posts yet
</div>`;
        }
        console.error('Error loading posts:', error);
    }
}

// Append the next page of posts to the bottom of the feed. Guarded against
// overlapping calls (feedIsLoadingMore) and re-fetching past the end
// (feedExhausted). Failures are silent and retried on the next scroll
// event - a spinner/toast here would be noisier than useful for a
// background pagination fetch.
async function loadMoreFeedPosts() {
    if (feedIsLoadingMore || feedExhausted || feedNextCursor == null) return;
    feedIsLoadingMore = true;

    const container = document.getElementById('feed-posts-container');
    // Inserted fresh each call and always removed in `finally` below, rather
    // than a static hidden element - renderFeedPosts replaces the whole
    // container's innerHTML on every fresh load, which would wipe a
    // pre-existing static sentinel anyway.
    const loadingRow = document.createElement('div');
    loadingRow.id = 'feed-loading-more';
    loadingRow.className = 'flex items-center justify-center py-4 text-gray-400 text-sm';
    loadingRow.textContent = 'Loading more...';
    if (container) container.appendChild(loadingRow);

    try {
        const response = await fetch(`/api/posts?limit=${FEED_PAGE_SIZE}&cursor=${feedNextCursor}`);
        if (!response.ok) {
            throw new Error('Failed to load more posts');
        }
        const data = await response.json();

        if (container && data.posts.length > 0) {
            container.insertAdjacentHTML('beforeend', data.posts.map(buildPostCardHtml).join(''));
        }

        feedNextCursor = data.next_cursor;
        feedExhausted = data.next_cursor === null;
    } catch (error) {
        console.error('Error loading more posts:', error);
        // Leave feedNextCursor as-is so the next scroll event retries.
    } finally {
        feedIsLoadingMore = false;
        loadingRow.remove();
    }
}

// feed-posts-container is itself the scrollable element (overflow-y-auto),
// so infinite scroll listens on it directly rather than the window.
(function initFeedInfiniteScroll() {
    const container = document.getElementById('feed-posts-container');
    if (!container) return;
    container.addEventListener('scroll', () => {
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (distanceFromBottom < FEED_SCROLL_THRESHOLD_PX) {
            loadMoreFeedPosts();
        }
    });
})();

