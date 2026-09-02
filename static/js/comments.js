// ---- Comment Overlay Functionality ----

let currentPostId = null;
let currentPostAuthorId = null;

// Feed card three-dot ("more options") bottom sheet tracks its own
// post/author context separately from the comment overlay's currentPostId,
// since the sheet is a singleton opened from any card in the feed.
let activeSheetPostId = null;
let activeSheetPostAuthorId = null;

// Returns true only when the logged-in session user is the author of the
// given post. Used to gate the Delete option in both the feed card's
// bottom sheet and the comment overlay's popover, and never trusted alone —
// the actual delete request is re-checked for ownership server-side.
function isCurrentUserPostOwner(authorId) {
	return !!(session && session.user && authorId != null && String(session.user.id) === String(authorId));
}

// Post card interactions (read more, three-dot menu, comment, like) are
// delegated per-container rather than globally, so any view that renders
// post cards built with buildPostCardHtml needs its container id listed
// here. Currently: the main feed, the Profile screen's Posts tab, and
// another user's profile Posts tab (user-profile-posts-container) — this
// last one was missing, which silently dropped comment/like/menu clicks
// on any post viewed from someone else's profile page.
const postCardContainerIds = ['feed-posts-container', 'profile-posts-container', 'user-profile-posts-container'];

// Delegated click listener for "Read more" expansion
postCardContainerIds.forEach(function(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.addEventListener('click', function(e) {
		const readMoreBtn = e.target.closest('.read-more-btn');
		if (!readMoreBtn) return;
		const contentEl = readMoreBtn.closest('.post-content');
		if (!contentEl) return;
		contentEl.classList.add('expanded');
		readMoreBtn.remove();
	});
});

// Delegated click listener for the post three-dot ("more options") button
postCardContainerIds.forEach(function(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.addEventListener('click', function(e) {
		const menuBtn = e.target.closest('.post-menu-btn');
		if (!menuBtn) return;

		const postCard = menuBtn.closest('article[data-post-id]');
		activeSheetPostId = postCard ? postCard.dataset.postId : null;
		activeSheetPostAuthorId = postCard ? postCard.dataset.postUserId : null;

		openPostMenu();
	});
});

// Delegated click listener for comment buttons
postCardContainerIds.forEach(function(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.addEventListener('click', function(e) {
		const commentBtn = e.target.closest('.comment-btn');
		if (!commentBtn) return;

		const postCard = commentBtn.closest('article[data-post-id]');
		if (!postCard) return;

		const postId = postCard.dataset.postId;
		let images = [];
		try {
			images = JSON.parse(postCard.dataset.postImages || '[]');
		} catch (e) {
			images = [];
		}
		const postData = {
			id: postId,
			user_id: postCard.dataset.postUserId,
			author_name: postCard.dataset.postAuthorName,
			author_handle: postCard.dataset.postAuthorHandle,
			author_avatar: postCard.dataset.postAuthorAvatar || null,
			content: postCard.dataset.postContent,
			created_at: postCard.dataset.postCreatedAt,
			like_count: postCard.dataset.postLikeCount,
			comment_count: postCard.dataset.postCommentCount,
			liked_by_user: postCard.dataset.postLiked === 'true',
			images: images
		};

		openCommentOverlay(postData);
	});
});

// Delegated click listener for post like buttons
postCardContainerIds.forEach(function(containerId) {
	const container = document.getElementById(containerId);
	if (!container) return;
	container.addEventListener('click', async function(e) {
	const likeBtn = e.target.closest('.like-btn');
	if (!likeBtn) return;

	e.preventDefault();
	e.stopPropagation();

	const postId = likeBtn.dataset.postId;
	const isLiked = likeBtn.dataset.liked === 'true';
	const likeCountSpan = likeBtn.querySelector('.like-count');
	const iconWrapper = likeBtn.querySelector('.like-icon-wrapper');
	const heartOutline = likeBtn.querySelector('.heart-outline');
	const heartFilled = likeBtn.querySelector('.heart-filled');

	// Store original state for rollback
	const originalCount = parseInt(likeCountSpan.textContent);
	const originalLiked = isLiked;

	// Optimistic update
	const newLiked = !isLiked;
	const newCount = newLiked ? originalCount + 1 : originalCount - 1;

	likeBtn.dataset.liked = newLiked;

	// Add count change animation
	likeCountSpan.classList.add('count-changing');
	likeCountSpan.textContent = newCount;
	setTimeout(() => likeCountSpan.classList.remove('count-changing'), 140);

	if (newLiked) {
		// Liking animation
		likeBtn.classList.add('is-liking');
		heartOutline.classList.remove('text-gray-500');
		heartOutline.classList.add('text-brand-red');
		likeCountSpan.classList.remove('text-gray-500');
		likeCountSpan.classList.add('text-brand-red');

		// Remove animation class after it completes
		setTimeout(() => likeBtn.classList.remove('is-liking'), 550);
	} else {
		// Unliking animation
		likeBtn.classList.add('is-unliking');
		heartOutline.classList.remove('text-brand-red');
		heartOutline.classList.add('text-gray-500');
		likeCountSpan.classList.remove('text-brand-red');
		likeCountSpan.classList.add('text-gray-500');

		// Remove animation class after it completes
		setTimeout(() => likeBtn.classList.remove('is-unliking'), 180);
	}

	// Update data attributes on the article
	const postCard = likeBtn.closest('article[data-post-id]');
	if (postCard) {
		postCard.dataset.postLiked = newLiked;
		postCard.dataset.postLikeCount = newCount;
	}

	try {
		const response = await apiFetch(`/api/posts/${postId}/like`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error('Failed to like post');
		}

		const data = await response.json();

		// Reconcile with server response
		likeBtn.dataset.liked = data.liked;
		likeCountSpan.textContent = data.like_count;

		if (postCard) {
			postCard.dataset.postLiked = data.liked;
			postCard.dataset.postLikeCount = data.like_count;
		}

		// Update overlay if it's open for this post
		if (currentPostId == postId) {
			const overlayLikeBtn = document.getElementById('overlay-post-like-btn');
			const overlayLikeCount = document.getElementById('overlay-post-likes');
			if (overlayLikeBtn && overlayLikeCount) {
				overlayLikeBtn.dataset.liked = data.liked;
				overlayLikeCount.textContent = data.like_count;

				const overlayIconWrapper = overlayLikeBtn.querySelector('.like-icon-wrapper');
				const overlayHeartOutline = overlayLikeBtn.querySelector('.heart-outline');
				const overlayHeartFilled = overlayLikeBtn.querySelector('.heart-filled');
				const overlayCountSpan = overlayLikeCount;

				if (data.liked) {
					overlayHeartOutline.classList.remove('text-gray-700');
					overlayHeartOutline.classList.add('text-brand-red');
					overlayCountSpan.classList.remove('text-gray-700');
					overlayCountSpan.classList.add('text-brand-red');
				} else {
					overlayHeartOutline.classList.remove('text-brand-red');
					overlayHeartOutline.classList.add('text-gray-700');
					overlayCountSpan.classList.remove('text-brand-red');
					overlayCountSpan.classList.add('text-gray-700');
				}
			}
		}

	} catch (error) {
		console.error('Error liking post:', error);

		// Revert optimistic update
		likeBtn.dataset.liked = originalLiked;
		likeCountSpan.textContent = originalCount;

		if (originalLiked) {
			heartOutline.classList.remove('text-gray-500');
			heartOutline.classList.add('text-brand-red');
			likeCountSpan.classList.remove('text-gray-500');
			likeCountSpan.classList.add('text-brand-red');
		} else {
			heartOutline.classList.remove('text-brand-red');
			heartOutline.classList.add('text-gray-500');
			likeCountSpan.classList.remove('text-brand-red');
			likeCountSpan.classList.add('text-gray-500');
		}

		if (postCard) {
			postCard.dataset.postLiked = originalLiked;
			postCard.dataset.postLikeCount = originalCount;
		}
	}
	});
});

function openCommentOverlay(postData) {
	currentPostId = postData.id;
	currentPostAuthorId = postData.user_id;

	// Populate post header
	const avatarUrl = postData.author_avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(postData.author_handle)}`;
	document.getElementById('overlay-post-avatar').src = avatarUrl;
	document.getElementById('overlay-post-author').textContent = postData.author_name;
	document.getElementById('overlay-post-handle').textContent = `@${postData.author_handle}`;

	const overlayImages = document.getElementById('overlay-post-images');
	const imagesHtml = buildPostImagesHtml(postData.images);
	if (imagesHtml) {
		overlayImages.innerHTML = imagesHtml;
		overlayImages.classList.remove('hidden');
	} else {
		overlayImages.innerHTML = '';
		overlayImages.classList.add('hidden');
	}

	document.getElementById('overlay-post-content').textContent = postData.content;
	document.getElementById('overlay-post-time').textContent = formatPostTime(postData.created_at);
	document.getElementById('overlay-post-comments').textContent = postData.comment_count;

	// Convert like stat block into a clickable button and set initial state
	const likesParent = document.getElementById('overlay-post-likes').parentElement;
	const isLiked = postData.liked_by_user;
	const likedTextClass = isLiked ? 'text-brand-red' : 'text-gray-700';

	likesParent.id = 'overlay-post-like-btn';
	likesParent.className = `flex items-center gap-2 transition-colors cursor-pointer`;
	likesParent.dataset.liked = isLiked;

	const likeIconWrapper = likesParent.querySelector('.like-icon-wrapper');
	const heartOutline = likesParent.querySelector('.heart-outline');
	const likeCount = document.getElementById('overlay-post-likes');
	heartOutline.classList.remove('text-gray-700', 'text-brand-red');
	heartOutline.classList.add(likedTextClass);
	likeCount.classList.remove('text-gray-700', 'text-brand-red');
	likeCount.classList.add(likedTextClass);
	likeCount.textContent = postData.like_count;

	// Show overlay
	const overlay = document.getElementById('comment-overlay');
	overlay.classList.remove('hidden');
	document.body.classList.add('overlay-open');

	// Show loading state
	document.getElementById('overlay-loading').classList.remove('hidden');
	document.getElementById('overlay-empty').classList.add('hidden');
	document.getElementById('overlay-error').classList.add('hidden');
	document.getElementById('overlay-comments-container').innerHTML = '';

	// Reset composer: clears any reply-to chip and disabled-send state left
	// over from a previous post's overlay.
	cancelReplyContext();
	updateReplyComposerState();

	// Fetch comments
	fetchComments(postData.id);
}

function closeCommentOverlay() {
	const overlay = document.getElementById('comment-overlay');
	overlay.classList.add('hidden');
	document.body.classList.remove('overlay-open');
	currentPostId = null;
	currentPostAuthorId = null;
	closeOverlayPostMenu();

	// Clear state
	document.getElementById('overlay-reply-input').value = '';
	document.getElementById('overlay-reply-error').classList.add('hidden');
	document.getElementById('overlay-comments-container').innerHTML = '';
	cancelReplyContext();
	updateReplyComposerState();
}

// ---- Post Action Menu (three-dot) ----
// All actions in this sheet are intentionally non-functional (visual only,
// tap feedback via CSS active: variants) — no handlers wired for
// data-action buttons yet. Delete lives only in the comment overlay's
// popover menu, not here.
function openPostMenu() {
	document.getElementById('post-menu-sheet').classList.remove('hidden');
	document.getElementById('post-menu-backdrop').classList.remove('hidden');
	document.body.classList.add('overlay-open');
}

function closePostMenu() {
	document.getElementById('post-menu-sheet').classList.add('hidden');
	document.getElementById('post-menu-backdrop').classList.add('hidden');
	document.body.classList.remove('overlay-open');
}

document.getElementById('post-menu-cancel-btn').addEventListener('click', closePostMenu);

// ---- Post & Comments overlay header menu (three-dot popover) ----
// Same non-functional convention as the feed card's post-menu-sheet for
// actions other than Delete. Delete is ownership-gated against
// currentPostAuthorId (set when the overlay opens) and re-checked
// server-side on the actual delete request.
function toggleOverlayPostMenu() {
	const popover = document.getElementById('overlay-menu-popover');
	const opening = popover.classList.contains('hidden');
	if (opening) {
		openOverlayPostMenu();
	} else {
		closeOverlayPostMenu();
	}
}

function openOverlayPostMenu() {
	const isOwner = isCurrentUserPostOwner(currentPostAuthorId);
	document.getElementById('overlay-menu-delete-btn').classList.toggle('hidden', !isOwner);
	document.getElementById('overlay-menu-delete-divider').classList.toggle('hidden', !isOwner);

	document.getElementById('overlay-menu-popover').classList.remove('hidden');
	document.getElementById('overlay-menu-backdrop').classList.remove('hidden');
	document.getElementById('overlay-menu-btn').setAttribute('aria-expanded', 'true');
}

function closeOverlayPostMenu() {
	document.getElementById('overlay-menu-popover').classList.add('hidden');
	document.getElementById('overlay-menu-backdrop').classList.add('hidden');
	document.getElementById('overlay-menu-btn').setAttribute('aria-expanded', 'false');
}

document.getElementById('overlay-menu-delete-btn').addEventListener('click', function() {
	const postId = currentPostId;
	closeOverlayPostMenu();
	openDeletePostDialog(postId);
});

// ---- Delete Post ----
let pendingDeletePostId = null;

function openDeletePostDialog(postId) {
	if (!postId) return;
	pendingDeletePostId = postId;
	document.getElementById('delete-post-backdrop').classList.remove('hidden');
	document.getElementById('delete-post-dialog').classList.remove('hidden');
}

function closeDeletePostDialog() {
	document.getElementById('delete-post-backdrop').classList.add('hidden');
	document.getElementById('delete-post-dialog').classList.add('hidden');
	pendingDeletePostId = null;
}

// Removes a post card from the DOM (feed + any place it's rendered) and
// restores each container's empty state if that was its last post. Only
// called after a confirmed successful server-side deletion.
function removePostFromDom(postId) {
	document.querySelectorAll(`article[data-post-id="${postId}"]`).forEach(card => card.remove());

	const feedContainer = document.getElementById('feed-posts-container');
	if (feedContainer && !feedContainer.querySelector('article[data-post-id]')) {
		feedContainer.innerHTML = `
<div class="flex items-center justify-center h-full min-h-[50vh] text-gray-400 text-sm">
No posts yet
</div>`;
	}

	const profileContainer = document.getElementById('profile-posts-container');
	if (profileContainer) {
		if (!profileContainer.querySelector('article[data-post-id]')) {
			profileContainer.innerHTML = `
<div class="flex flex-col items-center justify-center py-16 text-gray-400 text-sm gap-2">
<i class="fa-regular fa-note-sticky text-3xl text-gray-300"></i>
No posts yet
</div>`;
		}
		const countEl = document.getElementById('profile-posts-count');
		if (countEl) {
			const remaining = profileContainer.querySelectorAll('article[data-post-id]').length;
			countEl.textContent = remaining;
		}
	}
}

async function confirmDeletePost() {
	const postId = pendingDeletePostId;
	if (!postId) return;

	const confirmBtn = document.getElementById('delete-post-confirm-btn');
	const originalLabel = confirmBtn.textContent;
	confirmBtn.disabled = true;
	confirmBtn.textContent = 'Deleting…';

	try {
		const response = await apiFetch(`/api/posts/${postId}`, {
			method: 'DELETE',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			let message = 'Failed to delete post. Please try again.';
			try {
				const data = await response.json();
				if (data && data.error) message = data.error;
			} catch (parseError) {
				// Non-JSON error body; fall back to the generic message.
			}
			throw new Error(message);
		}

		// Success: drop the post from the feed and close anything referencing it.
		removePostFromDom(postId);

		if (currentPostId == postId) {
			closeCommentOverlay();
		}

		closeDeletePostDialog();
		showToast('Post deleted');
	} catch (error) {
		console.error('Error deleting post:', error);
		// Leave the post in the feed untouched — nothing was removed from the
		// DOM until the request succeeded, so there's no inconsistent state
		// to roll back. Just close the confirm dialog and surface the error.
		closeDeletePostDialog();
		showToast(error.message || 'Failed to delete post. Please try again.');
	} finally {
		confirmBtn.disabled = false;
		confirmBtn.textContent = originalLabel;
	}
}

document.getElementById('delete-post-confirm-btn').addEventListener('click', confirmDeletePost);

// Defensive-only: interactive-widget=resizes-content (meta tag) + the
// #comment-overlay dvh rule are what actually keep the reply bar above the
// keyboard now. This just nudges the input fully into view on focus, to
// cover slow keyboard-open animations or engines that honor dvh but are
// still mid-transition when focus lands. Doesn't resize or reposition
// anything itself — safe no-op once the layout is already correct.
document.getElementById('overlay-reply-input').addEventListener('focus', function() {
	const input = this;
	setTimeout(() => input.scrollIntoView({ block: 'nearest' }), 300);
});

async function fetchComments(postId) {
	try {
		const response = await fetch(`/api/posts/${postId}/comments`);

		if (!response.ok) {
			throw new Error('Failed to load comments');
		}

		const comments = await response.json();

		// Hide loading
		document.getElementById('overlay-loading').classList.add('hidden');

		// Update heading
		document.getElementById('overlay-replies-heading').textContent = `Replies (${comments.length})`;

		if (comments.length === 0) {
			document.getElementById('overlay-empty').classList.remove('hidden');
		} else {
			renderComments(comments);
		}

	} catch (error) {
		console.error('Error loading comments:', error);
		document.getElementById('overlay-loading').classList.add('hidden');
		const errorDiv = document.getElementById('overlay-error');
		errorDiv.textContent = 'Failed to load comments. Please try again.';
		errorDiv.classList.remove('hidden');
	}
}

// Single source of truth for a comment row's markup — used on initial load
// (renderComments) and when a newly-posted comment is inserted
// (handleSendReply / insertNewCommentIntoDom), so the two paths can't drift
// out of sync.
//
// data-comment-user-id carries the author's user id (added by the backend
// alongside the existing comment fields) so the per-comment "..." menu can
// gate Delete to the comment's own author, checked again against `session`
// in isCurrentUserCommentOwner(). If the field is absent from the API
// response, ownership just evaluates false and only Report shows — no crash.
//
// isReply/parentHandle come from the caller's tree-walk (buildCommentTree),
// not from the comment object itself: parent_comment_id can point arbitrarily
// deep (reply-to-a-reply is valid data), but indentation is intentionally
// capped at one visual level so long chains don't run the layout off-screen.
// data-parent-comment-id still carries the real (uncapped) parent id.
function buildCommentHtml(comment, isReply, parentHandle) {
	const avatarUrl = comment.author_avatar || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(comment.author_handle)}`;
	const timeAgo = formatTimeAgo(comment.created_at);
	const likedClass = comment.liked_by_user ? 'text-brand-red' : 'text-gray-500';
	const authorUserId = comment.user_id !== undefined && comment.user_id !== null ? String(comment.user_id) : '';
	const parentCommentId = comment.parent_comment_id !== undefined && comment.parent_comment_id !== null ? String(comment.parent_comment_id) : '';

	const rowIndentClass = isReply ? 'ml-10 pl-3 border-l-2 border-gray-100' : '';
	const replyingToLine = isReply && parentHandle
		? `<div class="text-[13px] text-gray-400 mb-1">Replying to @${escapeHtml(parentHandle)}</div>`
		: '';

	return `
	<div class="pb-5 mb-5 border-b border-gray-100 flex gap-3 last:border-b-0 ${rowIndentClass}" data-comment-id="${comment.id}" data-comment-user-id="${escapeHtml(authorUserId)}" data-comment-author-handle="${escapeHtml(comment.author_handle)}" data-parent-comment-id="${escapeHtml(parentCommentId)}">
		<img alt="${escapeHtml(comment.author_name)}" class="w-12 h-12 rounded-full object-cover shrink-0" src="${avatarUrl}"/>
		<div class="flex-1 min-w-0">
			<div class="flex items-start justify-between gap-2">
				<div class="flex items-baseline gap-1.5 mb-1 flex-wrap">
					<span class="font-bold text-[16px]">${escapeHtml(comment.author_name)}</span>
					<span class="text-[14px] text-gray-500">@${escapeHtml(comment.author_handle)} · ${escapeHtml(timeAgo)}</span>
				</div>
				<button type="button" class="comment-menu-btn p-1 -mr-1 -mt-1 text-gray-400 hover:text-gray-600 focus:outline-none shrink-0" aria-label="Comment options">
					<i class="fa-solid fa-ellipsis-vertical text-[14px]"></i>
				</button>
			</div>
			${replyingToLine}
			<p class="text-[16px] leading-[1.4] text-gray-800 mb-3">${escapeHtml(comment.content)}</p>
			<div class="flex items-center gap-5 text-gray-500">
				<button class="like-btn-comment flex items-center gap-1.5 focus:outline-none group transition-colors" data-comment-id="${comment.id}" data-liked="${comment.liked_by_user}">
					<span class="like-icon-wrapper">
						<svg class="w-5 h-5 ${likedClass} heart-outline" fill="none" stroke="currentColor" stroke-width="1.5" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
							<path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" stroke-linecap="round" stroke-linejoin="round"></path>
						</svg>
						<svg class="w-5 h-5 text-brand-red heart-filled absolute inset-0" fill="currentColor" stroke="none" viewbox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
							<path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"></path>
						</svg>
					</span>
					<span class="text-[14px] like-count ${likedClass}">${comment.like_count}</span>
				</button>
				<button type="button" class="comment-reply-btn flex items-center gap-1.5 text-gray-500 hover:text-gray-700 focus:outline-none">
					<i class="fa-solid fa-reply text-[13px]"></i>
					<span class="text-[14px] font-medium">Reply</span>
				</button>
			</div>
		</div>
	</div>`;
}

// Flattens the parent_comment_id graph into render order: each top-level
// comment immediately followed by its full descendant chain (depth-first,
// chronological within each parent), so replies always sit directly under
// the comment they were made on rather than at the bottom of the list.
// Returns [{ comment, isReply, parentHandle }, ...].
function buildCommentRenderList(comments) {
	const byId = {};
	comments.forEach(function(c) { byId[c.id] = c; });

	const childrenByParent = {};
	comments.forEach(function(c) {
		const key = c.parent_comment_id != null ? String(c.parent_comment_id) : 'root';
		if (!childrenByParent[key]) childrenByParent[key] = [];
		childrenByParent[key].push(c);
	});

	const output = [];
	function walk(key) {
		(childrenByParent[key] || []).forEach(function(c) {
			const parent = key !== 'root' ? byId[key] : null;
			output.push({
				comment: c,
				isReply: !!parent,
				parentHandle: parent ? parent.author_handle : null
			});
			walk(String(c.id));
		});
	}
	walk('root');
	return output;
}

function renderComments(comments) {
	const container = document.getElementById('overlay-comments-container');
	container.innerHTML = buildCommentRenderList(comments)
		.map(function(node) { return buildCommentHtml(node.comment, node.isReply, node.parentHandle); })
		.join('');
}

// Inserts a freshly-posted comment/reply into the already-rendered list
// without a full refetch. Top-level comments append to the end (matches
// ASC sort order). Replies are placed directly after the last existing row
// belonging to the same parent chain (or after the parent itself if it has
// no visible replies yet), so the thread stays visually grouped.
function insertNewCommentIntoDom(comment, parentCommentId, parentHandle) {
	const container = document.getElementById('overlay-comments-container');

	if (!parentCommentId) {
		container.insertAdjacentHTML('beforeend', buildCommentHtml(comment, false, null));
		return;
	}

	const html = buildCommentHtml(comment, true, parentHandle);
	const existingReplies = container.querySelectorAll(`[data-parent-comment-id="${parentCommentId}"]`);

	if (existingReplies.length > 0) {
		existingReplies[existingReplies.length - 1].insertAdjacentHTML('afterend', html);
		return;
	}

	const parentRow = container.querySelector(`[data-comment-id="${parentCommentId}"]`);
	if (parentRow) {
		parentRow.insertAdjacentHTML('afterend', html);
	} else {
		// Parent row not found (shouldn't happen — its Reply button is what
		// set parentCommentId). Fall back to appending so the comment isn't lost.
		container.insertAdjacentHTML('beforeend', html);
	}
}

// GPA calculator iframe back button -> return to Courses
window.addEventListener('message', (e) => {
	if (e.data === 'gpa-back') { showView('courses'); }
});

// Close overlay handlers
document.getElementById('close-overlay-btn').addEventListener('click', closeCommentOverlay);
document.getElementById('comment-overlay').addEventListener('click', function(e) {
	if (e.target === this) {
		closeCommentOverlay();
	}
});

// Reply input handlers
document.getElementById('overlay-reply-send-btn').addEventListener('click', handleSendReply);
document.getElementById('overlay-reply-input').addEventListener('keypress', function(e) {
	if (e.key === 'Enter') {
		handleSendReply();
	}
});

// Char counter + send-button enabled state, kept in sync on every keystroke.
// Mirrors the compose screen's submit-post-btn convention (disabled until
// there's content, swapped for a spinner while a request is in flight).
document.getElementById('overlay-reply-input').addEventListener('input', updateReplyComposerState);

function updateReplyComposerState() {
	const input = document.getElementById('overlay-reply-input');
	const counter = document.getElementById('overlay-reply-counter');
	const sendBtn = document.getElementById('overlay-reply-send-btn');
	const length = input.value.length;

	if (length > 0) {
		counter.textContent = `${length}/1000`;
		counter.classList.remove('hidden');
		counter.classList.toggle('text-red-500', length > 1000);
		counter.classList.toggle('text-gray-400', length <= 1000);
	} else {
		counter.classList.add('hidden');
	}

	sendBtn.disabled = length === 0 || length > 1000;
}

function setReplySendLoading(isLoading) {
	const sendBtn = document.getElementById('overlay-reply-send-btn');
	const spinner = document.getElementById('overlay-reply-send-spinner');
	const icon = document.getElementById('overlay-reply-send-icon');

	sendBtn.setAttribute('aria-busy', String(isLoading));
	spinner.classList.toggle('hidden', !isLoading);
	icon.classList.toggle('hidden', isLoading);

	if (isLoading) {
		sendBtn.disabled = true;
	} else {
		updateReplyComposerState();
	}
}

