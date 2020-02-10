// imports
const fs = require('fs')
const util = require('util')
const writeFile = util.promisify(fs.writeFile)
const readFile = util.promisify(fs.readFile)
const _ = require('underscore-plus')
let GitHubApi
let PackageManager
let ForkGistIdInputView

// constants
// const DESCRIPTION = 'Atom configuration storage operated by http://atom.io/packages/sync-settings'
const REMOVE_KEYS = [
	'sync-settings.gistId',
	'sync-settings.personalAccessToken',
	'sync-settings._analyticsUserId', // keep legacy key in blacklist
	'sync-settings._lastBackupHash',
]

module.exports = {
	config: require('./config'),

	activate () {
		// speedup activation by async initializing
		setImmediate(() => {
			// actual initialization after atom has loaded
			if (!GitHubApi) {
				GitHubApi = require('@octokit/rest')
			}
			if (!PackageManager) {
				PackageManager = require('./package-manager')
			}

			const { CompositeDisposable } = require('atom')
			this.disposables = new CompositeDisposable()

			this.disposables.add(
				atom.commands.add('atom-workspace', 'sync-settings:backup', this.backup.bind(this)),
				atom.commands.add('atom-workspace', 'sync-settings:restore', this.restore.bind(this)),
				atom.commands.add('atom-workspace', 'sync-settings:view-backup', this.viewBackup.bind(this)),
				atom.commands.add('atom-workspace', 'sync-settings:check-backup', this.checkForUpdate.bind(this, true)),
				atom.commands.add('atom-workspace', 'sync-settings:fork', this.inputForkGistId.bind(this)),
			)

			const mandatorySettingsApplied = this.checkMandatorySettings()
			if (mandatorySettingsApplied && atom.config.get('sync-settings.checkForUpdatedBackup')) {
				this.checkForUpdate()
			}
		})
	},

	deactivate () {
		this.disposables.dispose()
		if (this.inputView) {
			this.inputView.destroy()
		}
	},

	serialize () {},

	getGistId () {
		let gistId = atom.config.get('sync-settings.gistId') || process.env.GIST_ID
		if (gistId) {
			gistId = gistId.trim()
		}
		return gistId
	},

	async getGist () {
		const gistId = this.getGistId()
		console.debug(`Getting gist ${gistId}`)
		const gist = await this.createClient().gists.get({ gist_id: gistId })
		return gist
	},

	getPersonalAccessToken () {
		let token = atom.config.get('sync-settings.personalAccessToken') || process.env.GITHUB_TOKEN
		if (token) {
			token = token.trim()
		}
		return token
	},

	checkMandatorySettings () {
		const missingSettings = []
		if (!this.getGistId()) {
			missingSettings.push('Gist ID')
		}
		if (!this.getPersonalAccessToken()) {
			missingSettings.push('GitHub personal access token')
		}
		if (missingSettings.length) {
			this.notifyMissingMandatorySettings(missingSettings)
		}
		return missingSettings.length === 0
	},

	async checkForUpdate (showNotification) {
		if (!this.getGistId()) {
			return this.notifyMissingMandatorySettings(['Gist ID'])
		}

		console.debug('checking latest backup...')
		try {
			const res = await this.getGist()

			if (!res || !res.data || !res.data.history || !res.data.history[0] || !res.data.history[0].version) {
				console.error('could not interpret result:', res)
				atom.notifications.addError('sync-settings: Error retrieving your settings.')
				return
			}

			console.debug(`latest backup version ${res.data.history[0].version}`)
			if (res.data.history[0].version !== atom.config.get('sync-settings._lastBackupHash')) {
				this.notifyNewerBackup()
			} else if (showNotification || !atom.config.get('sync-settings.quietUpdateCheck')) {
				this.notifyBackupUptodate()
			}
		} catch (err) {
			console.error('error while retrieving the gist. does it exists?', err)
			atom.notifications.addError(`sync-settings: Error retrieving your settings. (${this._gistIdErrorMessage(err)})`)
		}
	},

	notifyNewerBackup () {
		// we need the actual element for dispatching on it
		const workspaceElement = atom.views.getView(atom.workspace)
		const notification = atom.notifications.addWarning('sync-settings: Your settings are out of date.', {
			dismissable: true,
			buttons: [{
				text: 'Backup',
				onDidClick () {
					atom.commands.dispatch(workspaceElement, 'sync-settings:backup')
					notification.dismiss()
				},
			}, {
				text: 'View backup',
				onDidClick () {
					atom.commands.dispatch(workspaceElement, 'sync-settings:view-backup')
				},
			}, {
				text: 'Restore',
				onDidClick () {
					atom.commands.dispatch(workspaceElement, 'sync-settings:restore')
					notification.dismiss()
				},
			}, {
				text: 'Dismiss',
				onDidClick () {
					notification.dismiss()
				},
			}],
		})
	},

	notifyBackupUptodate () {
		atom.notifications.addSuccess('sync-settings: Latest backup is already applied.')
	},

	notifyMissingMandatorySettings (missingSettings) {
		const context = this
		const errorMsg = 'sync-settings: Mandatory settings missing: ' + missingSettings.join(', ')

		const notification = atom.notifications.addError(errorMsg, {
			dismissable: true,
			buttons: [{
				text: 'Package settings',
				onDidClick () {
					context.goToPackageSettings()
					notification.dismiss()
				},
			}],
		})
	},

	notifyWarnBackupConfig () {
		const notification = atom.notifications.addWarning('sync-settings: Backing up `config.cson` is risky.', {
			detail: `
\`config.cson\` contains your Personal Access Token
You can store it in the environment variable \`GITHUB_TOKEN\`

Do you want to back up this file anyway?`.trim(),
			dismissable: true,
			buttons: [{
				text: 'Backup Anyway',
				onDidClick () {
					atom.config.set('sync-settings.warnBackupConfig', false)
					atom.commands.dispatch(atom.views.getView(atom.workspace), 'sync-settings:backup')
					notification.dismiss()
				},
			}],
		})
	},

	async backup () {
		const extraFiles = atom.config.get('sync-settings.extraFiles') || []
		if (atom.config.get('sync-settings.personalAccessToken') && extraFiles.includes('config.cson') && atom.config.get('sync-settings.warnBackupConfig')) {
			this.notifyWarnBackupConfig()
			return
		}

		const files = {}
		if (atom.config.get('sync-settings.syncSettings')) {
			files['settings.json'] = { content: await this.getFilteredSettings() }
		}
		if (atom.config.get('sync-settings.syncPackages')) {
			files['packages.json'] = { content: JSON.stringify(this.getPackages(), null, '\t') }
		}
		if (atom.config.get('sync-settings.syncKeymap')) {
			const content = await this.fileContent(atom.keymaps.getUserKeymapPath())
			files['keymap.cson'] = { content: content !== null ? content : '# keymap file (not found)' }
		}
		if (atom.config.get('sync-settings.syncStyles')) {
			const content = await this.fileContent(atom.styles.getUserStyleSheetPath())
			files['styles.less'] = { content: content !== null ? content : '// styles file (not found)' }
		}
		if (atom.config.get('sync-settings.syncInit')) {
			const initPath = atom.getUserInitScriptPath()
			const content = await this.fileContent(initPath)
			const path = require('path')
			files[path.basename(initPath)] = { content: content !== null ? content : '# initialization file (not found)' }
		}
		if (atom.config.get('sync-settings.syncSnippets')) {
			const content = await this.fileContent(atom.getConfigDirPath() + '/snippets.cson')
			files['snippets.cson'] = { content: content !== null ? content : '# snippets file (not found)' }
		}

		for (const file of extraFiles) {
			const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
			let cmtstart = '#'
			let cmtend = ''
			if (['.less', '.scss', '.js'].includes(ext)) {
				cmtstart = '//'
			}
			if (['.css'].includes(ext)) {
				cmtstart = '/*'
				cmtend = '*/'
			}
			const content = await this.fileContent(atom.getConfigDirPath() + `/${file}`)
			files[file] = { content: content !== null ? content : `${cmtstart} ${file} (not found) ${cmtend}` }
		}

		try {
			const gistId = this.getGistId()
			console.debug(`Updating gist ${gistId}`)
			const res = await this.createClient().gists.update({
				gist_id: gistId,
				description: atom.config.get('sync-settings.gistDescription'),
				files,
			})

			atom.config.set('sync-settings._lastBackupHash', res.data.history[0].version)
			atom.notifications.addSuccess(`sync-settings: Your settings were successfully backed up. <br/><a href="${res.data.html_url}">Click here to open your Gist.</a>`)
		} catch (err) {
			console.error('error backing up data: ' + err.message, err)
			atom.notifications.addError(`sync-settings: Error backing up your settings. (${this._gistIdErrorMessage(err)})`)
		}
	},

	viewBackup () {
		const Shell = require('shell')
		const gistId = this.getGistId()
		Shell.openExternal(`https://gist.github.com/${gistId}`)
	},

	getPackages () {
		const packages = []
		const object = this._getAvailablePackageMetadataWithoutDuplicates()
		for (const i in object) {
			const metadata = object[i]
			const { name, version, theme, apmInstallSource } = metadata
			packages.push({ name, version, theme, apmInstallSource })
		}
		return _.sortBy(packages, 'name')
	},

	_getAvailablePackageMetadataWithoutDuplicates () {
		const path2metadata = {}
		const packageMetadata = atom.packages.getAvailablePackageMetadata()
		const iterable = atom.packages.getAvailablePackagePaths()
		for (let i = 0; i < iterable.length; i++) {
			const path = iterable[i]
			path2metadata[fs.realpathSync(path)] = packageMetadata[i]
		}

		const packages = []
		const object = atom.packages.getAvailablePackageNames()
		for (const prop in object) {
			const pkgName = object[prop]
			const pkgPath = atom.packages.resolvePackagePath(pkgName)
			if (path2metadata[pkgPath]) {
				packages.push(path2metadata[pkgPath])
			} else {
				console.error('could not correlate package name, path, and metadata')
			}
		}
		return packages
	},

	async restore () {
		try {
			const res = await this.getGist()
			const files = Object.keys(res.data.files)

			// check if the JSON files are parsable
			for (const filename of files) {
				const file = res.data.files[filename]
				if (filename === 'settings.json' || filename === 'packages.json') {
					try {
						JSON.parse(file.content)
					} catch (err) {
						atom.notifications.addError(`sync-settings: Error parsing the fetched JSON file '${filename}'. (${err})`)
						return
					}
				}
			}

			const configDirPath = atom.getConfigDirPath()
			for (const filename of files) {
				const file = res.data.files[filename]
				switch (filename) {
				case 'settings.json':
					if (atom.config.get('sync-settings.syncSettings')) {
						this.updateSettings(JSON.parse(file.content))
					}
					break

				case 'packages.json': {
					if (atom.config.get('sync-settings.syncPackages')) {
						const packages = JSON.parse(file.content)
						await this.installMissingPackages(packages)
						if (atom.config.get('sync-settings.removeObsoletePackages')) {
							await this.removeObsoletePackages(packages)
						}
					}
					break
				}

				case 'keymap.cson':
					if (atom.config.get('sync-settings.syncKeymap')) {
						await writeFile(atom.keymaps.getUserKeymapPath(), file.content)
					}
					break

				case 'styles.less':
					if (atom.config.get('sync-settings.syncStyles')) {
						await writeFile(atom.styles.getUserStyleSheetPath(), file.content)
					}
					break

				case 'init.coffee':
					if (atom.config.get('sync-settings.syncInit')) {
						await writeFile(configDirPath + '/init.coffee', file.content)
					}
					break

				case 'init.js':
					if (atom.config.get('sync-settings.syncInit')) {
						await writeFile(configDirPath + '/init.js', file.content)
					}
					break

				case 'snippets.cson':
					if (atom.config.get('sync-settings.syncSnippets')) {
						await writeFile(configDirPath + '/snippets.cson', file.content)
					}
					break

				default:
					await writeFile(`${configDirPath}/${filename}`, file.content)
				}
			}

			atom.config.set('sync-settings._lastBackupHash', res.data.history[0].version)

			atom.notifications.addSuccess('sync-settings: Your settings were successfully synchronized.')
		} catch (err) {
			console.error('error while retrieving the gist. does it exists?', err)
			atom.notifications.addError(`sync-settings: Error retrieving your settings. (${this._gistIdErrorMessage(err)})`)
			throw err
		}
	},

	createClient () {
		const token = this.getPersonalAccessToken()

		if (token) {
			console.debug(`Creating GitHubApi client with token = ${token.substr(0, 4)}...${token.substr(-4, 4)}`)
		} else {
			console.error('Creating GitHubApi client without token')
		}

		const github = new GitHubApi.Octokit({
			auth: token,
			userAgent: 'Atom sync-settings',
		})

		return github
	},

	updateSettings (settings) {
		if (!('*' in settings)) {
			// backed up before v2.1.0
			settings = { '*': settings }
		}
		this.addFilteredSettings(settings)
		for (const scopeSelector in settings) {
			atom.config.set(null, settings[scopeSelector], { scopeSelector })
		}
	},

	addFilteredSettings (settings) {
		const blacklistedKeys = [
			...REMOVE_KEYS,
			...atom.config.get('sync-settings.blacklistedKeys') || [],
		]
		for (const blacklistedKey of blacklistedKeys) {
			if (typeof atom.config.get(blacklistedKey) === 'undefined') {
				continue
			}
			const blacklistedKeyPath = blacklistedKey.split('.')
			blacklistedKeyPath.unshift('*')
			this._addProperty(settings, blacklistedKeyPath, blacklistedKey)
		}
	},

	_addProperty (obj, keyPath, key) {
		const lastKey = keyPath.length === 1
		const currentKey = keyPath.shift()

		if (lastKey) {
			obj[currentKey] = atom.config.get(key)
		} else {
			if (!(currentKey in obj)) {
				obj[currentKey] = {}
			}
			if (_.isObject(obj[currentKey]) && !_.isArray(obj[currentKey])) {
				this._addProperty(obj[currentKey], keyPath, key)
			}
		}
	},

	async getFilteredSettings () {
		// _.clone() doesn't deep clone thus we are using JSON parse trick
		const settings = JSON.parse(JSON.stringify({
			'*': atom.config.settings,
			...atom.config.scopedSettingsStore.propertiesForSource(atom.config.mainSource),
		}))
		const blacklistedKeys = [
			...REMOVE_KEYS,
			...atom.config.get('sync-settings.blacklistedKeys') || [],
		]
		for (const blacklistedKey of blacklistedKeys) {
			const blacklistedKeyPath = blacklistedKey.split('.')
			blacklistedKeyPath.unshift('*')
			this._removeProperty(settings, blacklistedKeyPath)
		}
		return JSON.stringify(settings, null, '\t')
	},

	_removeProperty (obj, key) {
		const lastKey = key.length === 1
		const currentKey = key.shift()

		if (lastKey) {
			delete obj[currentKey]
		} else if (_.isObject(obj[currentKey]) && !_.isArray(obj[currentKey])) {
			this._removeProperty(obj[currentKey], key)
		}
	},

	goToPackageSettings () {
		return atom.workspace.open('atom://config/packages/sync-settings')
	},

	async removeObsoletePackages (packages) {
		const installedPackages = this.getPackages()
		const removePackages = installedPackages.filter(i => !packages.find(p => p.name === i.name))
		if (removePackages.length === 0) {
			atom.notifications.addInfo('Sync-settings: no packages to remove')
			return
		}

		const total = removePackages.length
		const notifications = {}
		const succeeded = []
		const failed = []
		const removeNextPackage = async () => {
			if (removePackages.length > 0) {
				// start removing next package
				const pkg = removePackages.shift()
				const i = total - removePackages.length
				notifications[pkg.name] = atom.notifications.addInfo(`Sync-settings: removing ${pkg.name} (${i}/${total})`, { dismissable: true })

				try {
					await this.removePackage(pkg)
					succeeded.push(pkg.name)
				} catch (err) {
					failed.push(pkg.name)
					atom.notifications.addWarning(`Sync-settings: failed to remove ${pkg.name}`)
				}

				notifications[pkg.name].dismiss()
				delete notifications[pkg.name]

				return removeNextPackage()
			} else if (Object.keys(notifications).length === 0) {
				// last package removed
				if (failed.length === 0) {
					atom.notifications.addSuccess(`Sync-settings: finished removing ${succeeded.length} packages`)
				} else {
					failed.sort()
					const failedStr = failed.join(', ')
					atom.notifications.addWarning(`Sync-settings: finished removing packages (${failed.length} failed: ${failedStr})`, { dismissable: true })
				}
			}
		}
		// start as many package removal in parallel as desired
		const concurrency = Math.min(removePackages.length, 8)
		const result = []
		for (let i = 0; i < concurrency; i++) {
			result.push(removeNextPackage())
		}
		await Promise.all(result)
	},

	async removePackage (pkg) {
		const type = pkg.theme ? 'theme' : 'package'
		console.info(`Removing ${type} ${pkg.name}...`)
		await new Promise((resolve, reject) => {
			// TODO: should packageManager be cached?
			const packageManager = new PackageManager()
			packageManager.uninstall(pkg, (err) => {
				if (err) {
					console.error(
						`Removing ${type} ${pkg.name} failed`,
						err.stack ? err.stack : err,
						err.stderr,
					)
					reject(err)
				} else {
					console.info(`Removing ${type} ${pkg.name}`)
					resolve()
				}
			})
		})
	},

	async installMissingPackages (packages) {
		const availablePackages = this.getPackages()
		const missingPackages = packages.filter(p => {
			const availablePackage = availablePackages.find(ap => ap.name === p.name)
			return !availablePackage || !!p.apmInstallSource !== !!availablePackage.apmInstallSource
		})
		if (missingPackages.length === 0) {
			atom.notifications.addInfo('Sync-settings: no packages to install')
			return
		}

		const total = missingPackages.length
		const notifications = {}
		const succeeded = []
		const failed = []
		const installNextPackage = async () => {
			if (missingPackages.length > 0) {
				// start installing next package
				const pkg = missingPackages.shift()
				const i = total - missingPackages.length
				notifications[pkg.name] = atom.notifications.addInfo(`Sync-settings: installing ${pkg.name} (${i}/${total})`, { dismissable: true })

				try {
					await this.installPackage(pkg)
					succeeded.push(pkg.name)
				} catch (err) {
					failed.push(pkg.name)
					atom.notifications.addWarning(`Sync-settings: failed to install ${pkg.name}`)
				}

				notifications[pkg.name].dismiss()
				delete notifications[pkg.name]

				return installNextPackage()
			} else if (Object.keys(notifications).length === 0) {
				// last package installation finished
				if (failed.length === 0) {
					atom.notifications.addSuccess(`Sync-settings: finished installing ${succeeded.length} packages`)
				} else {
					failed.sort()
					const failedStr = failed.join(', ')
					atom.notifications.addWarning(`Sync-settings: finished installing packages (${failed.length} failed: ${failedStr})`, { dismissable: true })
				}
			}
		}
		// start as many package installations in parallel as desired
		const concurrency = Math.min(missingPackages.length, 8)
		const result = []
		for (let i = 0; i < concurrency; i++) {
			result.push(installNextPackage())
		}
		await Promise.all(result)
	},

	async installPackage (pkg) {
		const type = pkg.theme ? 'theme' : 'package'
		console.info(`Installing ${type} ${pkg.name}...`)
		await new Promise((resolve, reject) => {
			// TODO: should packageManager be cached?
			const packageManager = new PackageManager()
			packageManager.install(pkg, (err) => {
				if (err) {
					console.error(
						`Installing ${type} ${pkg.name} failed`,
						err.stack ? err.stack : err,
						err.stderr,
					)
					reject(err)
				} else {
					console.info(`Installed ${type} ${pkg.name}`)
					resolve()
				}
			})
		})
	},

	async fileContent (filePath) {
		try {
			const content = await readFile(filePath, { encoding: 'utf8' })
			return content.trim() !== '' ? content : null
		} catch (err) {
			console.error(`Error reading file ${filePath}. Probably doesn't exist.`, err)
			return null
		}
	},

	inputForkGistId () {
		if (!ForkGistIdInputView) {
			ForkGistIdInputView = require('./fork-gistid-input-view')
		}
		this.inputView = new ForkGistIdInputView(this)
	},

	async forkGistId (forkId) {
		try {
			const res = await this.createClient().gists.fork({ gist_id: forkId })
			if (res.data.id) {
				atom.config.set('sync-settings.gistId', res.data.id)
				atom.notifications.addSuccess(`sync-settings: Forked successfully to the new Gist ID ${res.data.id} which has been saved to your config.`)
			} else {
				atom.notifications.addError('sync-settings: Error forking settings')
			}
		} catch (err) {
			atom.notifications.addError(`sync-settings: Error forking settings. (${this._gistIdErrorMessage(err)})`)
		}
	},

	_gistIdErrorMessage (err) {
		let message
		try {
			message = JSON.parse(err.message).message
			if (message === 'Not Found') {
				message = 'Gist ID Not Found'
			}
		} catch (SyntaxError) {
			message = err.message
		}
		return message
	},
}