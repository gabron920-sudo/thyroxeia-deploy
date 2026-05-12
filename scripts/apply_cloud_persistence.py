from pathlib import Path

path = Path('public/index.html')
s = path.read_text()

replacements = []

old = """  // 2. Fetch verified plan from Supabase — with 5s timeout so it never hangs
  try {
    const profilePromise = sb.from('profiles').select('plan').eq('id', currentUser.id).maybeSingle()
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ data: null, error: null }), 5000))
    const { data, error } = await Promise.race([profilePromise, timeoutPromise])
    if (!error && data?.plan) {
      userProfile.plan = data.plan
      localStorage.setItem(key, JSON.stringify({ ...userProfile, plan_user_id: currentUser.id }))
    }
  } catch(e) { /* non-fatal — use cached */ }

  // 3. Sync streak from localStorage
  userProfile.streak = getStreak()
}"""
new = """  // 2. Fetch verified profile from Supabase — with 5s timeout so it never hangs
  try {
    const profilePromise = sb.from('profiles')
      .select('plan,xp,streak,cards_studied,last_studied')
      .eq('id', currentUser.id)
      .maybeSingle()
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ data: null, error: null }), 5000))
    const { data, error } = await Promise.race([profilePromise, timeoutPromise])
    if (!error && data) {
      userProfile = {
        ...userProfile,
        plan: data.plan || userProfile.plan || 'free',
        xp: data.xp ?? userProfile.xp ?? 0,
        streak: data.streak ?? userProfile.streak ?? 0,
        cards_studied: data.cards_studied ?? userProfile.cards_studied ?? 0,
        last_studied: data.last_studied || userProfile.last_studied || ''
      }
      localStorage.setItem(key, JSON.stringify({ ...userProfile, plan_user_id: currentUser.id }))
    }
  } catch(e) { /* non-fatal — use cached */ }
}

async function cloudSaveProfileStats() {
  if (!currentUser) return
  const payload = {
    id: currentUser.id,
    xp: userProfile.xp || 0,
    streak: userProfile.streak || 0,
    cards_studied: userProfile.cards_studied || 0,
    last_studied: userProfile.last_studied || null
  }
  sb.from('profiles').upsert(payload, { onConflict: 'id' }).then(({ error }) => {
    if (error) console.warn('[Profile cloud save]', error.message)
  })
}"""
replacements.append((old,new))

old = """function addXP(amount) {
  if (!currentUser) return
  userProfile.xp = (userProfile.xp || 0) + amount
  const key = `thyroxeia_profile_${currentUser.id}`
  localStorage.setItem(key, JSON.stringify({ ...userProfile, plan_user_id: currentUser.id }))
  updateXPDisplay()
}"""
new = """function addXP(amount) {
  if (!currentUser) return
  userProfile.xp = (userProfile.xp || 0) + amount
  const key = `thyroxeia_profile_${currentUser.id}`
  localStorage.setItem(key, JSON.stringify({ ...userProfile, plan_user_id: currentUser.id }))
  cloudSaveProfileStats()
  updateXPDisplay()
}"""
replacements.append((old,new))

old = """function updateStreak() {
  if (!currentUser) return
  const key   = 'streak_' + currentUser.id
  const today = new Date().toISOString().slice(0, 10)
  const raw   = localStorage.getItem(key)
  let data    = raw ? JSON.parse(raw) : { streak: 0, lastStudied: '' }

  if (data.lastStudied === today) return  // already counted today

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  if (data.lastStudied === yesterday) {
    data.streak = (data.streak || 0) + 1  // continued streak
  } else if (data.lastStudied === '') {
    data.streak = 1  // first ever day
  } else {
    data.streak = 1  // missed a day — reset to 1
  }
  data.lastStudied = today
  localStorage.setItem(key, JSON.stringify(data))

  // Update userProfile and UI
  userProfile.streak = data.streak
  const profileKey = 'thyroxeia_profile_' + currentUser.id
  localStorage.setItem(profileKey, JSON.stringify({ ...userProfile, plan_user_id: currentUser.id }))
  updateXPDisplay()

  if (data.streak > 1) toast('🔥 ' + data.streak + '-day streak! Keep it up!', 'success')
}

function getStreak() {
  if (!currentUser) return 0
  const raw = localStorage.getItem('streak_' + currentUser.id)
  if (!raw) return 0
  const data = JSON.parse(raw)
  // Streak is only valid if studied today or yesterday
  const today     = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  if (data.lastStudied === today || data.lastStudied === yesterday) return data.streak || 0
  return 0  // streak broken
}"""
new = """function updateStreak() {
  if (!currentUser) return
  const today = new Date().toISOString().slice(0, 10)
  const lastStudied = userProfile.last_studied || ''

  if (lastStudied === today) return  // already counted today

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  if (lastStudied === yesterday) {
    userProfile.streak = (userProfile.streak || 0) + 1
  } else if (!lastStudied) {
    userProfile.streak = 1
  } else {
    userProfile.streak = 1
  }
  userProfile.last_studied = today

  const profileKey = 'thyroxeia_profile_' + currentUser.id
  localStorage.setItem(profileKey, JSON.stringify({ ...userProfile, plan_user_id: currentUser.id }))
  cloudSaveProfileStats()
  updateXPDisplay()

  if ((userProfile.streak || 0) > 1) toast('🔥 ' + userProfile.streak + '-day streak! Keep it up!', 'success')
}

function getStreak() {
  if (!currentUser) return 0
  const lastStudied = userProfile.last_studied || ''
  const today     = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  if (lastStudied === today || lastStudied === yesterday) return userProfile.streak || 0
  return 0
}"""
replacements.append((old,new))

old = """function loadDecks() {
  const stored = localStorage.getItem(`decks_${currentUser?.id}`)
  currentDecks = stored ? JSON.parse(stored) : []
  renderDecks()
}
function saveDecks() {
  localStorage.setItem(`decks_${currentUser?.id}`, JSON.stringify(currentDecks))
  document.getElementById('stat-decks').textContent = currentDecks.length
}"""
new = """async function loadDecks() {
  const cacheKey = `decks_${currentUser?.id}`
  const stored = localStorage.getItem(cacheKey)
  currentDecks = stored ? JSON.parse(stored) : []
  renderDecks()

  if (!currentUser) return
  try {
    const { data, error } = await sb.from('decks')
      .select('id,name,emoji,cards,created_at')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    currentDecks = (data || []).map(d => ({
      id: d.id,
      name: d.name,
      emoji: d.emoji || '📚',
      cards: d.cards || [],
      created: d.created_at
    }))
    localStorage.setItem(cacheKey, JSON.stringify(currentDecks))
    renderDecks()
  } catch(e) {
    console.warn('[Deck cloud load]', e.message)
  }
}
async function saveDecks() {
  localStorage.setItem(`decks_${currentUser?.id}`, JSON.stringify(currentDecks))
  document.getElementById('stat-decks').textContent = currentDecks.length
  if (!currentUser) return
  const rows = currentDecks.map(d => ({
    id: d.id,
    user_id: currentUser.id,
    name: d.name,
    emoji: d.emoji || '📚',
    cards: d.cards || [],
    created_at: d.created || new Date().toISOString()
  }))
  if (!rows.length) return
  const { error } = await sb.from('decks').upsert(rows, { onConflict: 'id' })
  if (error) console.warn('[Deck cloud save]', error.message)
}"""
replacements.append((old,new))

old = """function deleteDeck(i) {
  if (!confirm('Delete this deck?')) return
  currentDecks.splice(i, 1); saveDecks(); renderDecks(); toast('Deck deleted', 'info')
}"""
new = """async function deleteDeck(i) {
  if (!confirm('Delete this deck?')) return
  const deck = currentDecks[i]
  currentDecks.splice(i, 1); saveDecks(); renderDecks(); toast('Deck deleted', 'info')
  if (currentUser && deck?.id) {
    const { error } = await sb.from('decks').delete().eq('id', deck.id).eq('user_id', currentUser.id)
    if (error) console.warn('[Deck cloud delete]', error.message)
  }
}"""
replacements.append((old,new))

old = """  userProfile.cards_studied = (userProfile.cards_studied || 0) + 1
  localStorage.setItem(`thyroxeia_profile_${currentUser?.id}`, JSON.stringify({ ...userProfile, plan_user_id: currentUser?.id }))
  nextCard()"""
new = """  userProfile.cards_studied = (userProfile.cards_studied || 0) + 1
  localStorage.setItem(`thyroxeia_profile_${currentUser?.id}`, JSON.stringify({ ...userProfile, plan_user_id: currentUser?.id }))
  cloudSaveProfileStats()
  nextCard()"""
replacements.append((old,new))

for old, new in replacements:
    if old not in s:
        raise SystemExit('Patch pattern not found:\n' + old[:300])
    s = s.replace(old, new)

path.write_text(s)
print('Cloud persistence patch applied to public/index.html')
