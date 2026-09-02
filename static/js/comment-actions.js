// ---- Reply-to-a-specific-comment context ----
// Backend now has real parent_comment_id threading (see app/routes/posts.py).
// Tapping "Reply" on a comment or reply records that comment's id as the
// pending parent and shows a removable "Replying to @handle" context chip.
// The input text itself is left untouched — no more @handle text-prefix
// hack — the parent id travels out-of-band and is sent as JSON on submit.
let replyingToCommentId = null;
let replyingToHandle = null;

function startReplyTo(commentId, handle) {
	replyingToCommentId = commentId;
	replyingToHandle = handle;

	const context = document.getElementById('overlay-reply-context');
	document.getElementById('overlay-reply-context-handle').textContent = `@${handle}`;
	context.classList.remove('hidden');
	context.classList.add('flex');

	const input = document.getElementById('overlay-reply-input');
	input.focus();
}

function cancelReplyContext() {
	replyingToCommentId = null;
	replyingToHandle = null;

	const context = document.getElementById('overlay-reply-context');
	context.classList.add('hidden');
	context.classList.remove('flex');
}

document.getElementById('overlay-reply-context-cancel').addEventListener('click', cancelReplyContext);

document.addEventListener('click', function(e) {
	const replyBtn = e.target.closest('.comment-reply-btn');
	if (!replyBtn) return;
	const commentRow = replyBtn.closest('[data-comment-id]');
	if (!commentRow) return;
	startReplyTo(commentRow.dataset.commentId, commentRow.dataset.commentAuthorHandle);
});

// ---- Per-comment "..." menu (Reply / Copy / Report / Delete) ----
// Same bottom-sheet convention as the feed card's post-menu-sheet. Delete is
// ownership-gated against data-comment-user-id and re-checked server-side.
let activeCommentMenuId = null;
let activeCommentMenuUserId = null;
let activeCommentMenuHandle = null;

function isCurrentUserCommentOwner(authorUserId) {
	return !!(session && session.user && authorUserId && String(session.user.id) === String(authorUserId));
}

document.addEventListener('click', function(e) {
	const menuBtn = e.target.closest('.comment-menu-btn');
	if (!menuBtn) return;
	const commentRow = menuBtn.closest('[data-comment-id]');
	if (!commentRow) return;

	activeCommentMenuId = commentRow.dataset.commentId;
	activeCommentMenuUserId = commentRow.dataset.commentUserId;
	activeCommentMenuHandle = commentRow.dataset.commentAuthorHandle;

	openCommentMenu();
});

function openCommentMenu() {
	const isOwner = isCurrentUserCommentOwner(activeCommentMenuUserId);
	document.getElementById('comment-menu-delete-group').classList.toggle('hidden', !isOwner);
	document.getElementById('comment-menu-report-group').classList.toggle('hidden', isOwner);

	document.getElementById('comment-menu-sheet').classList.remove('hidden');
	document.getElementById('comment-menu-backdrop').classList.remove('hidden');
}

function closeCommentMenu() {
	document.getElementById('comment-menu-sheet').classList.add('hidden');
	document.getElementById('comment-menu-backdrop').classList.add('hidden');
}

document.getElementById('comment-menu-cancel-btn').addEventListener('click', closeCommentMenu);

document.getElementById('comment-menu-reply-btn').addEventListener('click', function() {
	const commentId = activeCommentMenuId;
	const handle = activeCommentMenuHandle;
	closeCommentMenu();
	if (commentId && handle) startReplyTo(commentId, handle);
});

document.getElementById('comment-menu-copy-btn').addEventListener('click', async function() {
	const row = document.querySelector(`[data-comment-id="${activeCommentMenuId}"]`);
	const text = row ? row.querySelector('p').textContent : '';
	closeCommentMenu();
	try {
		await navigator.clipboard.writeText(text);
		showToast('Comment copied');
	} catch (error) {
		showToast('Could not copy comment');
	}
});

document.getElementById('comment-menu-report-btn').addEventListener('click', function() {
	closeCommentMenu();
	showToast('Comment reported');
});

document.getElementById('comment-menu-delete-btn').addEventListener('click', function() {
	const commentId = activeCommentMenuId;
	closeCommentMenu();
	openDeleteCommentDialog(commentId);
});

// ---- Delete Comment ----
let pendingDeleteCommentId = null;

function openDeleteCommentDialog(commentId) {
	if (!commentId) return;
	pendingDeleteCommentId = commentId;
	document.getElementById('delete-comment-backdrop').classList.remove('hidden');
	document.getElementById('delete-comment-dialog').classList.remove('hidden');
}

function closeDeleteCommentDialog() {
	document.getElementById('delete-comment-backdrop').classList.add('hidden');
	document.getElementById('delete-comment-dialog').classList.add('hidden');
	pendingDeleteCommentId = null;
}

// Removes a comment row from the DOM and reconciles every comment-count
// display (overlay heading, overlay stat, feed/profile cards) against the
// number of rows actually left — same convention as removePostFromDom.
function removeCommentFromDom(commentId) {
	const row = document.querySelector(`[data-comment-id="${commentId}"]`);
	if (row) row.remove();

	const container = document.getElementById('overlay-comments-container');
	const remaining = container.querySelectorAll('[data-comment-id]').length;

	if (remaining === 0) {
		document.getElementById('overlay-empty').classList.remove('hidden');
	}

	document.getElementById('overlay-replies-heading').textContent = `Replies (${remaining})`;
	document.getElementById('overlay-post-comments').textContent = remaining;

	document.querySelectorAll(`article[data-post-id="${currentPostId}"]`).forEach(function(feedCard) {
		const commentCountSpan = feedCard.querySelector('.comment-count');
		if (commentCountSpan) {
			commentCountSpan.textContent = remaining;
		}
		feedCard.dataset.postCommentCount = remaining;
	});
}

async function confirmDeleteComment() {
	const commentId = pendingDeleteCommentId;
	if (!commentId) return;

	const confirmBtn = document.getElementById('delete-comment-confirm-btn');
	const originalLabel = confirmBtn.textContent;
	confirmBtn.disabled = true;
	confirmBtn.textContent = 'Deleting…';

	try {
		const response = await apiFetch(`/api/comments/${commentId}`, {
			method: 'DELETE',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			let message = 'Failed to delete comment. Please try again.';
			try {
				const data = await response.json();
				if (data && data.error) message = data.error;
			} catch (parseError) {
				// Non-JSON error body; fall back to the generic message.
			}
			throw new Error(message);
		}

		removeCommentFromDom(commentId);
		closeDeleteCommentDialog();
		showToast('Comment deleted');
	} catch (error) {
		console.error('Error deleting comment:', error);
		closeDeleteCommentDialog();
		showToast(error.message || 'Failed to delete comment. Please try again.');
	} finally {
		confirmBtn.disabled = false;
		confirmBtn.textContent = originalLabel;
	}
}

document.getElementById('delete-comment-confirm-btn').addEventListener('click', confirmDeleteComment);

let isSubmittingComment = false;

async function handleSendReply() {
	if (isSubmittingComment) return;

	// Check if logged in
	if (!session || !session.user || !session.user.id) {
		const errorDiv = document.getElementById('overlay-reply-error');
		errorDiv.textContent = 'Please log in to post a comment.';
		errorDiv.classList.remove('hidden');
		setTimeout(() => {
			closeCommentOverlay();
			showView('login');
		}, 1500);
		return;
	}

	const input = document.getElementById('overlay-reply-input');
	const content = input.value.trim();
	const errorDiv = document.getElementById('overlay-reply-error');

	errorDiv.classList.add('hidden');

	if (!content) {
		errorDiv.textContent = 'Comment cannot be empty.';
		errorDiv.classList.remove('hidden');
		return;
	}

	if (content.length > 1000) {
		errorDiv.textContent = 'Comment too long (max 1000 characters).';
		errorDiv.classList.remove('hidden');
		return;
	}

	isSubmittingComment = true;
	setReplySendLoading(true);

	// Capture the pending reply target before it's cleared below — needed
	// both for the request body and for placing the new row in the DOM.
	const parentCommentId = replyingToCommentId;
	const parentHandle = replyingToHandle;

	try {
		const body = { content };
		if (parentCommentId) {
			body.parent_comment_id = parentCommentId;
		}

		const response = await apiFetch(`/api/posts/${currentPostId}/comments`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body)
		});

		const data = await response.json();

		if (!response.ok) {
			throw new Error(data.error || 'Failed to post comment');
		}

		// Clear input and any active "Replying to" context
		input.value = '';
		cancelReplyContext();

		// Add new comment to list
		const isEmpty = document.getElementById('overlay-empty').classList.contains('hidden') === false;

		if (isEmpty) {
			document.getElementById('overlay-empty').classList.add('hidden');
		}

		// Own comment: attribute it to the logged-in user even if the
		// backend response doesn't include user_id yet, so the "..." menu
		// can offer Delete on it right away.
		if (data.user_id === undefined || data.user_id === null) {
			data.user_id = session.user.id;
		}
		if (data.parent_comment_id === undefined) {
			data.parent_comment_id = parentCommentId || null;
		}

		insertNewCommentIntoDom(data, parentCommentId, parentHandle);

		// Update replies heading
		const currentCount = parseInt(document.getElementById('overlay-post-comments').textContent);
		const newCount = currentCount + 1;
		document.getElementById('overlay-replies-heading').textContent = `Replies (${newCount})`;
		document.getElementById('overlay-post-comments').textContent = newCount;

		// Update comment count on every rendered instance of this card
		// (feed + profile can both have it mounted at once)
		document.querySelectorAll(`article[data-post-id="${currentPostId}"]`).forEach(function(feedCard) {
			const commentCountSpan = feedCard.querySelector('.comment-count');
			if (commentCountSpan) {
				commentCountSpan.textContent = newCount;
			}
			feedCard.dataset.postCommentCount = newCount;
		});

	} catch (error) {
		console.error('Error posting comment:', error);
		errorDiv.textContent = error.message || 'Failed to post comment. Please try again.';
		errorDiv.classList.remove('hidden');
	} finally {
		isSubmittingComment = false;
		setReplySendLoading(false);
	}
}

// Store session info globally for easy access
let session = null;
async function updateSessionInfo() {
	try {
		const response = await fetch('/api/session');
		const data = await response.json();
		setCsrfTokenFromResponseData(data);
		if (data.logged_in) {
			session = data;
			updateGreeting();
		} else {
			session = null;
		}
	} catch (error) {
		session = null;
	}
}

// Get time-of-day greeting based on local device time
function getGreeting() {
	const hour = new Date().getHours();
	if (hour < 12) {
		return 'Good morning';
	} else if (hour < 18) {
		return 'Good afternoon';
	} else {
		return 'Good evening';
	}
}

// Update the greeting in the feed header
function updateGreeting() {
	const greetingContainer = document.getElementById('feed-header-greeting');
	if (!greetingContainer) return;

	// If logged out or no full_name, show "Discover" as fallback
	if (!session || !session.user || !session.user.full_name) {
		greetingContainer.innerHTML = '<h1 class="text-lg font-bold text-gray-900">Discover</h1>';
		return;
	}

	// Extract first name from full_name
	const firstName = session.user.full_name.split(' ')[0];
	const greeting = getGreeting();

	// Update with two-line greeting
	greetingContainer.innerHTML = `
		<div class="text-lg font-bold text-gray-900 leading-tight">${greeting}</div>
		<div class="text-sm font-medium text-gray-500 leading-tight">${firstName}</div>
	`;
}

// Update session on load and after login/signup
updateSessionInfo();

// Overlay post like button click handler
document.addEventListener('click', async function(e) {
	const overlayLikeBtn = e.target.closest('#overlay-post-like-btn');
	if (!overlayLikeBtn) return;

	e.preventDefault();
	e.stopPropagation();

	const isLiked = overlayLikeBtn.dataset.liked === 'true';
	const likeCountSpan = document.getElementById('overlay-post-likes');
	const iconWrapper = overlayLikeBtn.querySelector('.like-icon-wrapper');
	const heartOutline = overlayLikeBtn.querySelector('.heart-outline');
	const heartFilled = overlayLikeBtn.querySelector('.heart-filled');

	// Store original state for rollback
	const originalCount = parseInt(likeCountSpan.textContent);
	const originalLiked = isLiked;

	// Optimistic update
	const newLiked = !isLiked;
	const newCount = newLiked ? originalCount + 1 : originalCount - 1;

	overlayLikeBtn.dataset.liked = newLiked;

	// Add count change animation
	likeCountSpan.classList.add('count-changing');
	likeCountSpan.textContent = newCount;
	setTimeout(() => likeCountSpan.classList.remove('count-changing'), 140);

	if (newLiked) {
		// Liking animation
		overlayLikeBtn.classList.add('is-liking');
		heartOutline.classList.remove('text-gray-700');
		heartOutline.classList.add('text-brand-red');
		likeCountSpan.classList.remove('text-gray-700');
		likeCountSpan.classList.add('text-brand-red');

		// Remove animation class after it completes
		setTimeout(() => overlayLikeBtn.classList.remove('is-liking'), 550);
	} else {
		// Unliking animation
		overlayLikeBtn.classList.add('is-unliking');
		heartOutline.classList.remove('text-brand-red');
		heartOutline.classList.add('text-gray-700');
		likeCountSpan.classList.remove('text-brand-red');
		likeCountSpan.classList.add('text-gray-700');

		// Remove animation class after it completes
		setTimeout(() => overlayLikeBtn.classList.remove('is-unliking'), 180);
	}

	try {
		const response = await apiFetch(`/api/posts/${currentPostId}/like`, {
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
		overlayLikeBtn.dataset.liked = data.liked;
		likeCountSpan.textContent = data.like_count;

		// Sync every rendered instance of this card (feed + profile can
		// both have it mounted at once)
		document.querySelectorAll(`article[data-post-id="${currentPostId}"]`).forEach(function(feedCard) {
			const feedLikeBtn = feedCard.querySelector('.like-btn');
			const feedLikeCount = feedCard.querySelector('.like-count');
			const feedHeartOutline = feedLikeBtn.querySelector('.heart-outline');

			feedLikeBtn.dataset.liked = data.liked;
			feedLikeCount.textContent = data.like_count;
			feedCard.dataset.postLiked = data.liked;
			feedCard.dataset.postLikeCount = data.like_count;

			if (data.liked) {
				feedHeartOutline.classList.remove('text-gray-500');
				feedHeartOutline.classList.add('text-brand-red');
				feedLikeCount.classList.remove('text-gray-500');
				feedLikeCount.classList.add('text-brand-red');
			} else {
				feedHeartOutline.classList.remove('text-brand-red');
				feedHeartOutline.classList.add('text-gray-500');
				feedLikeCount.classList.remove('text-brand-red');
				feedLikeCount.classList.add('text-gray-500');
			}
		});

	} catch (error) {
		console.error('Error liking post:', error);

		// Revert optimistic update
		overlayLikeBtn.dataset.liked = originalLiked;
		likeCountSpan.textContent = originalCount;

		if (originalLiked) {
			heartOutline.classList.remove('text-gray-700');
			heartOutline.classList.add('text-brand-red');
			likeCountSpan.classList.remove('text-gray-700');
			likeCountSpan.classList.add('text-brand-red');
		} else {
			heartOutline.classList.remove('text-brand-red');
			heartOutline.classList.add('text-gray-700');
			likeCountSpan.classList.remove('text-brand-red');
			likeCountSpan.classList.add('text-gray-700');
		}
	}
});

// Comment like button click handler
document.addEventListener('click', async function(e) {
	const likeBtn = e.target.closest('.like-btn-comment');
	if (!likeBtn) return;

	e.preventDefault();
	e.stopPropagation();

	const commentId = likeBtn.dataset.commentId;
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

	try {
		const response = await apiFetch(`/api/comments/${commentId}/like`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error('Failed to like comment');
		}

		const data = await response.json();

		// Reconcile with server response
		likeBtn.dataset.liked = data.liked;
		likeCountSpan.textContent = data.like_count;

	} catch (error) {
		console.error('Error liking comment:', error);

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
	}
});
