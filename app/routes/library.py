"""Library file storage, upload, search, and download routes."""
import os
import uuid
from flask import Blueprint, request, jsonify, session, send_from_directory
from werkzeug.utils import secure_filename
from app.db import get_db
from app.serializers import serialize_library_file

bp = Blueprint('library', __name__)

UPLOAD_FOLDER = 'static/uploads'
ALLOWED_EXTENSIONS = {'pdf', 'doc', 'docx', 'ppt', 'pptx', 'zip'}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB in bytes
VALID_CATEGORIES = {'Past Questions', 'Lecture Notes', 'Books', 'Projects', 'Other'}


@bp.route('/api/library/files', methods=['POST'])
def upload_file():
    """Upload a library file with metadata"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    # Validate multipart request
    if 'file' not in request.files:
        return jsonify({'error': 'No file selected.'}), 400

    file = request.files['file']
    if not file or not file.filename:
        return jsonify({'error': 'No file selected.'}), 400

    # Get form fields
    title = (request.form.get('title') or '').strip()
    category = (request.form.get('category') or '').strip()
    department = (request.form.get('department') or '').strip()
    course = (request.form.get('course') or '').strip()
    level = (request.form.get('level') or '').strip()

    # Validate required fields
    if not title:
        return jsonify({'error': 'Title is required.'}), 400

    if category not in VALID_CATEGORIES:
        return jsonify({'error': 'Invalid category.'}), 400

    # Validate file extension
    filename_lower = file.filename.lower()
    if not any(filename_lower.endswith(f'.{ext}') for ext in ALLOWED_EXTENSIONS):
        return jsonify({'error': 'Unsupported file type.'}), 400

    # Extract extension
    file_ext_with_dot = os.path.splitext(secure_filename(file.filename))[1].lower()
    file_type = file_ext_with_dot[1:]  # Remove the dot

    # Validate file size
    file.seek(0, os.SEEK_END)
    file_size = file.tell()
    file.seek(0)

    if file_size > MAX_FILE_SIZE:
        return jsonify({'error': 'File size exceeds 50MB limit.'}), 400

    # Generate unique filename
    unique_filename = f"{uuid.uuid4()}{file_ext_with_dot}"
    file_path_on_disk = os.path.join(UPLOAD_FOLDER, unique_filename)
    file_url = f"/static/uploads/{unique_filename}"

    try:
        # Save file to disk
        file.save(file_path_on_disk)

        # Insert into database
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('''
            INSERT INTO library_files
            (user_id, title, category, department, course, level, file_path, file_type, file_size, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')
        ''', (
            session['user_id'],
            title,
            category,
            department if department else None,
            course if course else None,
            level if level else None,
            file_url,
            file_type,
            file_size
        ))

        file_id = cursor.lastrowid
        conn.commit()

        # Fetch the created file with uploader info
        cursor.execute('''
            SELECT library_files.id, library_files.user_id, library_files.title,
                   library_files.category, library_files.department, library_files.course,
                   library_files.level, library_files.file_path, library_files.file_type,
                   library_files.file_size, library_files.status, library_files.download_count,
                   library_files.created_at, users.full_name
            FROM library_files
            JOIN users ON library_files.user_id = users.id
            WHERE library_files.id = ?
        ''', (file_id,))
        row = cursor.fetchone()
        conn.close()

        file_data = serialize_library_file(row[:13], uploader_name=row[13])
        return jsonify({'file': file_data}), 201

    except Exception:
        # Clean up file if database insert failed
        if os.path.exists(file_path_on_disk):
            try:
                os.remove(file_path_on_disk)
            except:
                pass
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500


@bp.route('/api/library/files', methods=['GET'])
def get_files():
    """Get filtered list of library files"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    # Get query parameters
    search = request.args.get('search', '').strip()
    category = request.args.get('category', '').strip()
    department = request.args.get('department', '').strip()

    current_user_id = session['user_id']

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Build query
        query = '''
            SELECT library_files.id, library_files.user_id, library_files.title,
                   library_files.category, library_files.department, library_files.course,
                   library_files.level, library_files.file_path, library_files.file_type,
                   library_files.file_size, library_files.status, library_files.download_count,
                   library_files.created_at, users.full_name
            FROM library_files
            JOIN users ON library_files.user_id = users.id
            WHERE (library_files.status = 'approved' OR library_files.user_id = ?)
        '''
        params = [current_user_id]

        # Add search filter (title OR course)
        if search:
            query += ' AND (library_files.title LIKE ? OR library_files.course LIKE ?)'
            search_pattern = f'%{search}%'
            params.extend([search_pattern, search_pattern])

        # Add category filter
        if category:
            query += ' AND library_files.category = ?'
            params.append(category)

        # Add department filter
        if department:
            query += ' AND library_files.department = ?'
            params.append(department)

        # Order and limit
        query += ' ORDER BY library_files.created_at DESC LIMIT 50'

        cursor.execute(query, params)
        rows = cursor.fetchall()
        conn.close()

        files = []
        for row in rows:
            files.append(serialize_library_file(row[:13], uploader_name=row[13]))

        return jsonify({'files': files}), 200

    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500


@bp.route('/api/library/departments', methods=['GET'])
def get_departments():
    """Get list of departments with file counts"""
    try:
        conn = get_db()
        cursor = conn.cursor()

        cursor.execute('''
            SELECT department, COUNT(*) as count
            FROM library_files
            WHERE status = 'approved'
              AND department IS NOT NULL
              AND department != ''
            GROUP BY department
            ORDER BY count DESC
        ''')
        rows = cursor.fetchall()
        conn.close()

        departments = []
        for name, count in rows:
            departments.append({'name': name, 'count': count})

        return jsonify({'departments': departments}), 200

    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500


@bp.route('/api/library/files/<int:file_id>/download', methods=['GET'])
def download_file(file_id):
    """Download a library file with access control"""
    if 'user_id' not in session:
        return jsonify({'error': 'Authentication required'}), 401

    try:
        conn = get_db()
        cursor = conn.cursor()

        # Fetch file record
        cursor.execute('''
            SELECT id, user_id, title, category, department, course, level,
                   file_path, file_type, file_size, status, download_count, created_at
            FROM library_files
            WHERE id = ?
        ''', (file_id,))
        row = cursor.fetchone()

        if not row:
            conn.close()
            return jsonify({'error': 'File not found.'}), 404

        file_record = serialize_library_file(row)

        # Access control: allow if approved OR user owns it
        if file_record['status'] != 'approved' and file_record['uploader_id'] != session['user_id']:
            conn.close()
            return jsonify({'error': 'You do not have access to this document.'}), 403

        # Extract filename from file_path (/static/uploads/filename)
        stored_filename = row[7].split('/')[-1]

        # Check if file exists on disk
        full_path = os.path.join(UPLOAD_FOLDER, stored_filename)
        if not os.path.exists(full_path):
            conn.close()
            return jsonify({'error': 'File not found.'}), 404

        # Increment download count (best effort)
        try:
            cursor.execute('''
                UPDATE library_files
                SET download_count = download_count + 1
                WHERE id = ?
            ''', (file_id,))
            conn.commit()
        except:
            pass  # Don't fail the download if count update fails

        conn.close()

        # Create a friendly download filename
        safe_title = "".join(c for c in file_record['title'] if c.isalnum() or c in (' ', '-', '_')).strip()
        if not safe_title:
            safe_title = "document"
        safe_title = safe_title[:100]  # Limit length
        download_name = f"{safe_title}.{file_record['file_type']}"

        return send_from_directory(
            UPLOAD_FOLDER,
            stored_filename,
            as_attachment=True,
            download_name=download_name
        )

    except Exception:
        return jsonify({'error': 'Something went wrong. Please try again.'}), 500

