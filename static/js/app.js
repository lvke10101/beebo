// ---- App bootstrap ----
// Runs after all other modules are loaded: kicks off session check
// (which drives the initial view) and wires up feed-only scroll behavior.

// Initialize
checkSession();

// FAB scroll behavior (feed-view only)
(function initFABScrollBehavior() {
	const feedMain = document.querySelector('#feed-view main.overflow-y-auto');
	const fab = document.getElementById('compose-fab');

	if (!feedMain || !fab) return;

	let lastScrollTop = 0;
	let scrollTimeout = null;

	feedMain.addEventListener('scroll', function() {
		const scrollTop = feedMain.scrollTop;

		// Clear any existing timeout
		if (scrollTimeout) {
			clearTimeout(scrollTimeout);
		}

		// Determine scroll direction
		if (scrollTop > lastScrollTop && scrollTop > 50) {
			// Scrolling down - hide FAB
			fab.classList.add('fab-hidden');
		} else {
			// Scrolling up - show FAB
			fab.classList.remove('fab-hidden');
		}

		lastScrollTop = scrollTop;

		// Show FAB after user stops scrolling (idle timeout)
		scrollTimeout = setTimeout(function() {
			fab.classList.remove('fab-hidden');
		}, 150);
	});
})();
