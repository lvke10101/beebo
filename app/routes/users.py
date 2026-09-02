"""User profile and follow routes."""
import os
import uuid
import time
import re
from flask import Blueprint, request, jsonify, session
from werkzeug.utils import secure_filename
from app.db import get_db
from app.serializers import serialize_user_public

bp = Blueprint('users', __name__)

UPLOAD_FOLDER = 'static/uploads'
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
ALLOWED_VIDEO_EXTENSIONS = {'mp4', 'mov', 'avi', 'webm', 'mkv'}
MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 5MB in bytes
MAX_HIGHLIGHT_SIZE = 25 * 1024 * 1024  # 25MB in bytes

# Rate limiting for follow endpoint: max 10 toggles per 60 seconds per user
FOLLOW_RATE_LIMIT_MAX = 10
FOLLOW_RATE_LIMIT_WINDOW = 60  # seconds
follow_rate_limiter = {}  # {user_id: [timestamp1, timestamp2, ...]}


def _delete_uploaded_file_if_local(image_url):
    """Best-effort cleanup of a previously uploaded file when it's replaced.
    Silently no-ops for None, external URLs, or anything outside our own
    upload folder — never let cleanup failure break the request."""
    if not image_url or not image_url.startswith('/static/uploads/'):
        return
    try:
        filename = os.path.basename(image_url)
        full_path = os.path.join(UPLOAD_FOLDER, filename)
        if os.path.commonpath([os.path.abspath(full_path), os.path.abspath(UPLOAD_FOLDER)]) == os.path.abspath(UPLOAD_FOLDER):
            if os.path.exists(full_path):
                os.remove(full_path)
    except OSError:
        pass


@bp.route('/api/users/<int:user_id>', methods=['GET'])
def get_user_public_profile(user_id):
    """Return the public profile fields for any user (avatar, cover, name,
    handle, post count) - used by the other-user profile screen. Unlike
    /api/session, this is not scoped to the logged-in user: it looks the
    requested user_id up directly so the viewer always gets that user's own
    data, not whatever happens to be in their own session."""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        'SELECT id, full_name, email, profile_picture, cover_image, username, bio FROM users WHERE id = ?',
        (user_id,)
    )
    row = cursor.fetchone()

    if row is None:
        conn.close()
        return jsonify({'error': 'User not found'}), 404

    cursor.execute('SELECT COUNT(*) FROM posts WHERE user_id = ?', (user_id,))
    post_count = cursor.fetchone()[0]

    # Follower/following counts come from actual rows in `follows`, not any
    # client-side/UI number, so they're correct on every load - including
    # a fresh page load with no prior client state at all.
    cursor.execute('SELECT COUNT(*) FROM follows WHERE followee_id = ?', (user_id,))
    follower_count = cursor.fetchone()[0]
    cursor.execute('SELECT COUNT(*) FROM follows WHERE follower_id = ?', (user_id,))
    following_count = cursor.fetchone()[0]

    is_following = False
    if 'user_id' in session:
        cursor.execute(
            'SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?',
            (session['user_id'], user_id)
        )
        is_following = cursor.fetchone() is not None

    conn.close()

    # Build response using serializer for shared fields, then add route-specific fields
    profile = serialize_user_public(row)
    profile.update({
        'post_count': post_count,
        'follower_count': follower_count,
        'following_count': following_count,
        'is_following': is_following
    })
    return jsonify(profile), 200


@bp.route('/api/users/<int:user_id>/follow', methods=['POST'])
def toggle_follow(user_id):
    """Toggle the logged-in user following user_id. Persists to the
    `follows` table (mirrors the like_post toggle pattern) so the
    relationship and the follower count survive a page refresh."""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    follower_id = session['user_id']
    if follower_id == user_id:
        return jsonify({'error': 'Cannot follow yourself'}), 400

    # Rate limiting: check timestamps for this user
    now = time.time()
    if follower_id not in follow_rate_limiter:
        follow_rate_limiter[follower_id] = []

    # Remove timestamps outside the sliding window
    follow_rate_limiter[follower_id] = [
        ts for ts in follow_rate_limiter[follower_id]
        if now - ts < FOLLOW_RATE_LIMIT_WINDOW
    ]

    # Check if user has exceeded the limit
    if len(follow_rate_limiter[follower_id]) >= FOLLOW_RATE_LIMIT_MAX:
        return jsonify({'error': 'Too many requests, slow down'}), 429

    # Record this request
    follow_rate_limiter[follower_id].append(now)

    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'User not found'}), 404

        cursor.execute(
            'SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?',
            (follower_id, user_id)
        )
        existing = cursor.fetchone()

        if existing:
            cursor.execute('DELETE FROM follows WHERE id = ?', (existing[0],))
            following = False
        else:
            try:
                cursor.execute(
                    'INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)',
                    (follower_id, user_id)
                )
                following = True
            except Exception:
                # Race condition: another request inserted this pair between our SELECT and INSERT
                # Roll back the failed insert, re-query current state, treat as "already following"
                conn.rollback()
                cursor.execute(
                    'SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?',
                    (follower_id, user_id)
                )
                existing = cursor.fetchone()
                following = existing is not None

        conn.commit()

        cursor.execute('SELECT COUNT(*) FROM follows WHERE followee_id = ?', (user_id,))
        follower_count = cursor.fetchone()[0]
        conn.close()

        return jsonify({'following': following, 'follower_count': follower_count}), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/users/<int:user_id>/highlights', methods=['GET'])
def get_user_highlights(user_id):
    """Get all highlights for a specific user, ordered by creation time"""
    try:
        conn = get_db()
        cursor = conn.cursor()

        # Verify user exists
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'User not found'}), 404

        # Fetch highlights
        cursor.execute('''
            SELECT id, title, kind, media_url, created_at
            FROM highlights
            WHERE user_id = ?
            ORDER BY created_at ASC
        ''', (user_id,))
        rows = cursor.fetchall()
        conn.close()

        highlights = []
        for row in rows:
            highlight_id, title, kind, media_url, created_at = row
            highlights.append({
                'id': highlight_id,
                'title': title,
                'kind': kind,
                'cover': media_url,
                'created_at': created_at
            })

        return jsonify(highlights), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/profile/picture', methods=['POST'])
def update_profile_picture():
    """Upload/replace the logged-in user's profile picture.

    Multipart form field: 'image' (single file). Overwrites the previous
    profile_picture value; the old uploaded file (if any) is best-effort
    deleted from disk. Passing profile_picture as NULL/omitted elsewhere
    always falls back to the generated DiceBear avatar on the frontend.
    """
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    if 'image' not in request.files or not request.files['image'].filename:
        return jsonify({'error': 'No image file provided.'}), 400

    file = request.files['image']

    if not file.content_type or not file.content_type.startswith('image/'):
        return jsonify({'error': 'Only image files are supported.'}), 400

    filename_lower = file.filename.lower()
    if not any(filename_lower.endswith(f'.{ext}') for ext in ALLOWED_EXTENSIONS):
        return jsonify({'error': 'Only image files are supported.'}), 400

    file.seek(0, os.SEEK_END)
    file_size = file.tell()
    file.seek(0)
    if file_size > MAX_IMAGE_SIZE:
        return jsonify({'error': 'Image must be under 5MB.'}), 400

    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT profile_picture FROM users WHERE id = ?', (session['user_id'],))
        row = cursor.fetchone()
        old_path = row[0] if row else None

        file_ext = os.path.splitext(secure_filename(file.filename))[1]
        unique_filename = f"{uuid.uuid4()}{file_ext}"
        file_path = os.path.join(UPLOAD_FOLDER, unique_filename)
        file.save(file_path)
        image_url = f"/static/uploads/{unique_filename}"

        cursor.execute('UPDATE users SET profile_picture = ? WHERE id = ?', (image_url, session['user_id']))
        conn.commit()
        conn.close()

        _delete_uploaded_file_if_local(old_path)

        return jsonify({'success': True, 'profile_picture': image_url}), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/profile/cover', methods=['POST'])
def update_profile_cover():
    """Upload/replace the logged-in user's cover image.

    Multipart form field: 'image' (single file). Same validation as
    profile picture. NULL/omitted cover_image means "no custom cover" —
    the frontend keeps showing its default gradient banner.
    """
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    if 'image' not in request.files or not request.files['image'].filename:
        return jsonify({'error': 'No image file provided.'}), 400

    file = request.files['image']

    if not file.content_type or not file.content_type.startswith('image/'):
        return jsonify({'error': 'Only image files are supported.'}), 400

    filename_lower = file.filename.lower()
    if not any(filename_lower.endswith(f'.{ext}') for ext in ALLOWED_EXTENSIONS):
        return jsonify({'error': 'Only image files are supported.'}), 400

    file.seek(0, os.SEEK_END)
    file_size = file.tell()
    file.seek(0)
    if file_size > MAX_IMAGE_SIZE:
        return jsonify({'error': 'Image must be under 5MB.'}), 400

    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('SELECT cover_image FROM users WHERE id = ?', (session['user_id'],))
        row = cursor.fetchone()
        old_path = row[0] if row else None

        file_ext = os.path.splitext(secure_filename(file.filename))[1]
        unique_filename = f"{uuid.uuid4()}{file_ext}"
        file_path = os.path.join(UPLOAD_FOLDER, unique_filename)
        file.save(file_path)
        image_url = f"/static/uploads/{unique_filename}"

        cursor.execute('UPDATE users SET cover_image = ? WHERE id = ?', (image_url, session['user_id']))
        conn.commit()
        conn.close()

        _delete_uploaded_file_if_local(old_path)

        return jsonify({'success': True, 'cover_image': image_url}), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/profile', methods=['PATCH'])
def update_profile():
    """Update the logged-in user's profile (full_name, username, bio).

    Accepts JSON body with:
    - full_name: required, non-empty after trim, max 50 chars
    - username: required, non-empty after trim, max 30, alphanumeric/underscore/period only
    - bio: optional, max 150 chars
    """
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    data = request.get_json() or {}

    # Validate full_name
    full_name = (data.get('full_name') or '').strip()
    if not full_name:
        return jsonify({'error': 'Full name is required'}), 400
    if len(full_name) > 50:
        return jsonify({'error': 'Full name must be 50 characters or less'}), 400

    # Validate username
    username = (data.get('username') or '').strip()
    if not username:
        return jsonify({'error': 'Username is required'}), 400
    if len(username) > 30:
        return jsonify({'error': 'Username must be 30 characters or less'}), 400

    # Check username format: alphanumeric, underscore, period only
    if not re.match(r'^[a-zA-Z0-9_.]+$', username):
        return jsonify({'error': 'Username can only contain letters, numbers, underscores, and periods'}), 400

    # Validate bio
    bio = (data.get('bio') or '').strip()
    if bio and len(bio) > 150:
        return jsonify({'error': 'Bio must be 150 characters or less'}), 400
    # Store None instead of empty string
    bio = bio if bio else None

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Check username uniqueness (case-insensitive, excluding current user)
        cursor.execute(
            'SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?',
            (username, session['user_id'])
        )
        if cursor.fetchone():
            conn.close()
            return jsonify({'error': 'That username is already taken.'}), 409

        # Update the user
        cursor.execute(
            'UPDATE users SET full_name = ?, username = ?, bio = ? WHERE id = ?',
            (full_name, username, bio, session['user_id'])
        )
        conn.commit()
        conn.close()

        return jsonify({
            'success': True,
            'full_name': full_name,
            'username': username,
            'bio': bio
        }), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/highlights', methods=['POST'])
def create_highlight():
    """Create a new highlight with photo or video upload.

    Multipart form-data with fields:
    - media (file): photo or video file
    - title (string): max 20 characters
    """
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    if 'media' not in request.files or not request.files['media'].filename:
        return jsonify({'error': 'No media file provided.'}), 400

    title = request.form.get('title', '').strip()
    if not title:
        return jsonify({'error': 'Title is required.'}), 400

    if len(title) > 20:
        return jsonify({'error': 'Title must be 20 characters or less.'}), 400

    file = request.files['media']

    # Validate file type and determine kind
    if not file.content_type:
        return jsonify({'error': 'Unable to determine file type.'}), 400

    kind = None
    allowed_exts = None

    if file.content_type.startswith('image/'):
        kind = 'photo'
        allowed_exts = ALLOWED_EXTENSIONS
    elif file.content_type.startswith('video/'):
        kind = 'video'
        allowed_exts = ALLOWED_VIDEO_EXTENSIONS
    else:
        return jsonify({'error': 'Only image and video files are supported.'}), 400

    # Validate file extension
    filename_lower = file.filename.lower()
    if not any(filename_lower.endswith(f'.{ext}') for ext in allowed_exts):
        return jsonify({'error': 'Only image and video files are supported.'}), 400

    # Validate file size (25MB max)
    file.seek(0, os.SEEK_END)
    file_size = file.tell()
    file.seek(0)
    if file_size > MAX_HIGHLIGHT_SIZE:
        return jsonify({'error': 'File must be under 25MB.'}), 400

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Save file
        file_ext = os.path.splitext(secure_filename(file.filename))[1]
        unique_filename = f"{uuid.uuid4()}{file_ext}"
        file_path = os.path.join(UPLOAD_FOLDER, unique_filename)
        file.save(file_path)
        media_url = f"/static/uploads/{unique_filename}"

        # Insert highlight
        cursor.execute(
            'INSERT INTO highlights (user_id, title, kind, media_url) VALUES (?, ?, ?, ?)',
            (session['user_id'], title, kind, media_url)
        )
        highlight_id = cursor.lastrowid

        conn.commit()

        # Fetch the created highlight
        cursor.execute('''
            SELECT id, title, kind, media_url, created_at
            FROM highlights
            WHERE id = ?
        ''', (highlight_id,))
        row = cursor.fetchone()
        conn.close()

        highlight_id, title, kind, media_url, created_at = row
        highlight = {
            'id': highlight_id,
            'title': title,
            'kind': kind,
            'cover': media_url,
            'created_at': created_at
        }

        return jsonify(highlight), 201

    except Exception as e:
        return jsonify({'error': f'Server error: {str(e)}'}), 500


@bp.route('/api/highlights/<int:highlight_id>', methods=['DELETE'])
def delete_highlight(highlight_id):
    """Delete a highlight. Must belong to the requesting user."""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Verify highlight exists and check ownership
        cursor.execute('SELECT user_id, media_url FROM highlights WHERE id = ?', (highlight_id,))
        highlight = cursor.fetchone()

        if not highlight:
            conn.close()
            return jsonify({'error': 'Highlight not found'}), 404

        highlight_user_id, media_url = highlight

        # Enforce ownership
        if highlight_user_id != session['user_id']:
            conn.close()
            return jsonify({'error': 'You can only delete your own highlights'}), 403

        # Delete the highlight row
        cursor.execute('DELETE FROM highlights WHERE id = ?', (highlight_id,))
        conn.commit()
        conn.close()

        # Delete the file
        _delete_uploaded_file_if_local(media_url)

        return jsonify({'success': True}), 200

    except Exception as e:
        return jsonify({'error': f'Database error: {str(e)}'}), 500


@bp.route('/api/posts/<int:post_id>', methods=['DELETE'])
def delete_post(post_id):
    """Delete a post and all associated data"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Verify post exists and check ownership
        cursor.execute('SELECT user_id FROM posts WHERE id = ?', (post_id,))
        post = cursor.fetchone()

        if not post:
            conn.close()
            return jsonify({'error': 'Post not found'}), 404

        post_user_id = post[0]

        # Enforce ownership
        if post_user_id != session['user_id']:
            conn.close()
            return jsonify({'error': 'You can only delete your own posts'}), 403

        # Begin deletion process
        # 1. Fetch and delete image files, then delete post_images rows
        cursor.execute('SELECT image_path FROM post_images WHERE post_id = ?', (post_id,))
        image_rows = cursor.fetchall()

        for (image_path,) in image_rows:
            # image_path is like "/static/uploads/filename.jpg"
            # Convert to file system path
            if image_path.startswith('/static/uploads/'):
                filename = image_path.replace('/static/uploads/', '')
                file_path = os.path.join(UPLOAD_FOLDER, filename)
                if os.path.exists(file_path):
                    os.remove(file_path)

        cursor.execute('DELETE FROM post_images WHERE post_id = ?', (post_id,))

        # 2. Delete likes for comments on this post
        cursor.execute('''
            DELETE FROM likes
            WHERE target_type = 'comment'
            AND target_id IN (SELECT id FROM comments WHERE post_id = ?)
        ''', (post_id,))

        # 3. Delete comments for this post
        cursor.execute('DELETE FROM comments WHERE post_id = ?', (post_id,))

        # 4. Delete likes for this post
        cursor.execute('''
            DELETE FROM likes
            WHERE target_type = 'post' AND target_id = ?
        ''', (post_id,))

        # 5. Delete the post itself
        cursor.execute('DELETE FROM posts WHERE id = ?', (post_id,))

        conn.commit()
        conn.close()

        return jsonify({'success': True}), 200

    except Exception as e:
        if 'conn' in locals():
            conn.rollback()
            conn.close()
        return jsonify({'error': f'Database error: {str(e)}'}), 500
