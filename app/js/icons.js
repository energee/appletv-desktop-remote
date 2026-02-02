// Lucide-based inline SVG icons
// SVG paths sourced from https://github.com/lucide-icons/lucide (ISC License)

const ICONS = {
    'play': '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />',
    'pause': '<rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" />',
    'keyboard': '<path d="M10 8h.01" /><path d="M12 12h.01" /><path d="M14 8h.01" /><path d="M16 12h.01" /><path d="M18 8h.01" /><path d="M6 8h.01" /><path d="M7 16h10" /><path d="M8 12h.01" /><rect width="20" height="16" x="2" y="4" rx="2" />',
    'pointer': '<path d="M22 14a8 8 0 0 1-8 8" /><path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2" /><path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1" /><path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10" /><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />',
    'chevron-up': '<path d="m18 15-6-6-6 6" />',
    'chevron-down': '<path d="m6 9 6 6 6-6" />',
    'chevron-left': '<path d="m15 18-6-6 6-6" />',
    'chevron-right': '<path d="m9 18 6-6-6-6" />',
    'arrow-left': '<path d="m12 19-7-7 7-7" /><path d="M19 12H5" />',
    'tv': '<path d="m17 2-5 5-5-5" /><rect width="20" height="15" x="2" y="7" rx="2" />',
    'skip-back': '<path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z" /><path d="M3 20V4" />',
    'skip-forward': '<path d="M21 4v16" /><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z" />',
    'volume-1': '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" /><path d="M16 9a5 5 0 0 1 0 6" />',
    'volume-2': '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" /><path d="M16 9a5 5 0 0 1 0 6" /><path d="M19.364 18.364a9 9 0 0 0 0-12.728" />'
};

function icon(name) {
    var paths = ICONS[name];
    if (!paths) {
        console.warn('Unknown icon:', name);
        return '';
    }
    return '<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
}

// Render all data-icon placeholders on DOMContentLoaded
document.addEventListener('DOMContentLoaded', function() {
    var els = document.querySelectorAll('[data-icon]');
    for (var i = 0; i < els.length; i++) {
        els[i].innerHTML = icon(els[i].getAttribute('data-icon'));
    }
});
