/**
 * GitHub App creation via GitHub's **app-manifest** flow, shared by Settings → Integrations and the
 * setup wizard.
 *
 * The server renders a pre-filled manifest (name, this box's callback URL, least-privilege permissions);
 * GitHub only accepts it as a real form POST — it is far too large for a query string — so this builds a
 * hidden form and submits it, navigating to GitHub's "Create this GitHub App?" confirmation. GitHub then
 * creates the App and redirects back to the server with its credentials, which is why nothing here has to
 * be copied or pasted.
 *
 * Lives in `lib` rather than in either page because two callers driving the same flow through two
 * slightly different hand-rolled forms is how a callback URL quietly diverges.
 */
import { api } from './api'

/** Kick off the flow. Resolves with an error string when the manifest can't be prepared; on success the
 *  browser has already navigated to GitHub and nothing after this runs. */
export async function createGithubApp(org?: string): Promise<string | null> {
  const r = await api.githubManifest(org?.trim() || undefined)
  if (r.error || !r.postUrl || !r.manifest) return r.error || 'Could not prepare the manifest.'
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = r.postUrl
  form.style.display = 'none'
  const input = document.createElement('input')
  input.type = 'hidden'
  input.name = 'manifest'
  input.value = r.manifest
  form.appendChild(input)
  document.body.appendChild(form)
  form.submit()
  return null
}
