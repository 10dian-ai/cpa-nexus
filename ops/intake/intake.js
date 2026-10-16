// Public remote account intake page. Talks only to /api/external/* with an
// external service key; every value from the server is rendered as text.
(function () {
  'use strict'
  var STORAGE = 'nexus-intake-key'
  var MAX_FILE_BYTES = 8 * 1024 * 1024
  var state = { key: '', modules: [], module: null, poll: null }
  var $ = function (id) { return document.getElementById(id) }
  var steps = ['step-key', 'step-modules', 'step-intake', 'step-result']

  function show(id) { steps.forEach(function (step) { $(step).hidden = step !== id }) }
  function store(value) { try { if (value) sessionStorage.setItem(STORAGE, value); else sessionStorage.removeItem(STORAGE) } catch (e) { /* Private mode. */ } }
  function restore() { try { return sessionStorage.getItem(STORAGE) || '' } catch (e) { return '' } }
  function showError(id, message) { var node = $(id); node.textContent = message || ''; node.hidden = !message }

  function api(path, options) {
    options = options || {}
    var headers = { authorization: 'Bearer ' + state.key }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    return fetch(path, { method: options.method || 'GET', headers: headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), credentials: 'omit', cache: 'no-store' })
      .then(function (response) {
        return response.text().then(function (text) {
          var data = null
          try { data = text ? JSON.parse(text) : null } catch (e) { data = null }
          if (!response.ok) {
            var message = (data && (data.message || (data.error && data.error.message) || data.statusMessage)) || ('请求失败（HTTP ' + response.status + '）')
            if (response.status === 401) message = '外调 Key 无效或已停用'
            if (response.status === 429) message = (data && data.message) || '请求过于频繁，请稍后再试'
            var error = new Error(message); error.status = response.status; throw error
          }
          return data
        })
      }, function () { throw new Error('无法连接服务器，请检查网络') })
  }

  // ── Step 1: key ────────────────────────────────────────────────
  function enter(key) {
    state.key = key
    $('key-submit').disabled = true
    showError('key-error', '')
    return api('/api/external/modules').then(function (data) {
      store(key)
      state.modules = (data && data.modules) || []
      $('key-name').textContent = (data && data.key && data.key.name) || '外调 Key'
      renderModules()
      show('step-modules')
    }).catch(function (error) {
      store('')
      state.key = ''
      showError('key-error', error.message)
      show('step-key')
    }).then(function () { $('key-submit').disabled = false })
  }
  $('key-form').addEventListener('submit', function (event) {
    event.preventDefault()
    var key = $('key-input').value.trim()
    if (!/^ccm_service_[A-Za-z0-9_-]{43}$/.test(key)) { showError('key-error', 'Key 格式不正确：应以 ccm_service_ 开头'); return }
    enter(key)
  })
  $('logout').addEventListener('click', function () { store(''); state.key = ''; $('key-input').value = ''; show('step-key') })

  // ── Step 2: modules ────────────────────────────────────────────
  function renderModules() {
    var list = $('module-list')
    list.textContent = ''
    if (!state.modules.length) { var empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '这个 Key 没有任何模块的加号权限。'; list.appendChild(empty); return }
    state.modules.forEach(function (module) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'module ' + module.id
      button.setAttribute('role', 'listitem')
      button.disabled = module.enabled === false
      var badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = (module.name || module.id).slice(0, 1).toUpperCase()
      var body = document.createElement('span')
      var title = document.createElement('strong'); title.textContent = module.name + (module.enabled === false ? '（已停用）' : '')
      var text = document.createElement('p'); text.textContent = module.description || ''
      body.appendChild(title); body.appendChild(text)
      var chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '›'
      button.appendChild(badge); button.appendChild(body); button.appendChild(chev)
      button.addEventListener('click', function () { openModule(module) })
      list.appendChild(button)
    })
  }

  // ── Step 3: intake form ────────────────────────────────────────
  function openModule(module) {
    state.module = module
    $('intake-title').textContent = '给 ' + module.name + ' 加号'
    $('intake-description').textContent = module.description || ''
    var formats = $('format-list')
    formats.textContent = ''
    ;(module.formats || []).forEach(function (format) {
      var item = document.createElement('li')
      var name = document.createElement('strong'); name.textContent = format.label
      var text = document.createElement('span'); text.textContent = format.description
      var example = document.createElement('code'); example.textContent = format.example
      item.appendChild(name); item.appendChild(text); item.appendChild(example)
      formats.appendChild(item)
    })
    $('intake-files').accept = module.accept || ''
    $('intake-files').value = ''
    $('intake-text').value = ''
    $('file-summary').hidden = true
    showError('intake-error', '')
    show('step-intake')
    $('intake-text').focus()
  }
  $('back').addEventListener('click', function () { show('step-modules') })
  $('intake-files').addEventListener('change', function () {
    var files = Array.prototype.slice.call($('intake-files').files || [])
    var summary = $('file-summary')
    summary.hidden = !files.length
    summary.textContent = files.length ? '已选择 ' + files.length + ' 个文件：' + files.map(function (file) { return file.name }).join('、') : ''
  })

  function readFiles() {
    var files = Array.prototype.slice.call($('intake-files').files || [])
    return Promise.all(files.map(function (file) {
      if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error(file.name + ' 超过 8 MB'))
      return file.text().then(function (content) { return { name: file.name.slice(0, 255), content: content } })
    }))
  }

  $('intake-form').addEventListener('submit', function (event) {
    event.preventDefault()
    var text = $('intake-text').value
    var module = state.module
    if (!module) return
    $('intake-submit').disabled = true
    showError('intake-error', '')
    readFiles().then(function (files) {
      if (!text.trim() && !files.length) throw new Error('请粘贴账号或选择文件')
      var body = {}
      if (text.trim()) body.text = text
      if (files.length) body.files = files
      return api('/api/external/modules/' + encodeURIComponent(module.id) + '/accounts', { method: 'POST', body: body })
    }).then(function (result) {
      $('intake-text').value = ''
      $('intake-files').value = ''
      startResult(result)
    }).catch(function (error) {
      showError('intake-error', error.message)
      if (error.status === 401) { store(''); show('step-key') }
    }).then(function () { $('intake-submit').disabled = false })
  })

  // ── Step 4: progress ───────────────────────────────────────────
  function setText(id, value) { $(id).textContent = String(value) }
  function renderErrors(errors) {
    var list = $('r-error-list')
    list.textContent = ''
    ;(errors || []).slice(0, 500).forEach(function (issue) {
      var item = document.createElement('li')
      item.textContent = '第 ' + issue.line + ' 条：' + issue.message
      list.appendChild(item)
    })
    $('r-errors').hidden = !list.childNodes.length
  }
  function startResult(result) {
    if (state.poll) clearTimeout(state.poll)
    show('step-result')
    setText('r-accepted', result.accepted); setText('r-rejected', result.rejected); setText('r-duplicates', result.duplicates)
    $('r-final').hidden = true
    renderErrors(result.errors)
    var parseErrors = result.errors || []
    if (!result.accepted) {
      $('result-title').textContent = result.rejected ? '没有可导入的账号' : '这些账号都已存在'
      $('r-progress').max = 1; $('r-progress').value = 1
      setText('r-progress-text', '')
      return
    }
    $('result-title').textContent = '正在导入…'
    var poll = function () {
      api('/api/external/jobs/' + encodeURIComponent(result.jobId)).then(function (job) {
        var progress = job.progress || { processed: 0, total: result.accepted }
        $('r-progress').max = Math.max(1, progress.total || result.accepted)
        $('r-progress').value = progress.processed || 0
        setText('r-progress-text', '已处理 ' + (progress.processed || 0) + ' / ' + (progress.total || result.accepted))
        if (job.status === 'completed' && job.result) {
          $('result-title').textContent = '导入完成 ✿'
          $('result-title').className = 'done'
          $('r-final').hidden = false
          setText('r-imported', job.result.imported); setText('r-updated', job.result.updated)
          setText('r-skipped', job.result.skipped); setText('r-failed', job.result.failed)
          renderErrors(parseErrors.concat(job.result.errors || []))
          return
        }
        if (job.status === 'failed') { $('result-title').textContent = '导入任务中断'; setText('r-progress-text', job.error || '请稍后重试'); return }
        state.poll = setTimeout(poll, 1500)
      }).catch(function (error) {
        setText('r-progress-text', error.message + '，稍后自动重试')
        state.poll = setTimeout(poll, 4000)
      })
    }
    poll()
  }
  $('again').addEventListener('click', function () { $('result-title').className = ''; if (state.module) openModule(state.module) })
  $('to-modules').addEventListener('click', function () { $('result-title').className = ''; show('step-modules') })

  var saved = restore()
  if (saved) enter(saved); else show('step-key')
})()
