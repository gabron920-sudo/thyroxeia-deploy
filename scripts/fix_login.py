with open("public/index.html", "r") as f:
    content = f.read()

old = """    const authPromise = sb.auth.signInWithPassword({
      email: document.getElementById('login-email').value,
      password: document.getElementById('login-password').value
    })
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Login timed out. Please try again.')), 10000))
    const { data: loginData, error } = await Promise.race([authPromise, timeoutPromise])
    if (error) {
      toast(error.message, 'error')
    } else if (loginData?.session) {
      currentUser = loginData.session.user
      await loadProfile()
      showPage('app')
    }"""

new = """    const { error } = await sb.auth.signInWithPassword({
      email: document.getElementById('login-email').value,
      password: document.getElementById('login-password').value
    })
    if (error) {
      toast(error.message, 'error')
    }
    // onAuthStateChange handles loadProfile() + showPage('app') on success"""

if old in content:
    with open("public/index.html", "w") as f:
        f.write(content.replace(old, new))
    print("SUCCESS: Fix applied")
else:
    print("ERROR: Pattern not found")
    import subprocess
    r = subprocess.run(["grep", "-n", "authPromise\\|loginData", "public/index.html"], capture_output=True, text=True)
    print(r.stdout)
