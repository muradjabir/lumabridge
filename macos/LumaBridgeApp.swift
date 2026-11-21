// LumaBridgeApp.swift — Native macOS Desktop Application for LumaBridge
// Wraps the LumaBridge interface in a native Cocoa/WebKit window, monitors
// the background daemon, and auto-starts the service if needed.

import Cocoa
import WebKit

class LumaBridgeAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var loadingLabel: NSTextField!
    var spinner: NSProgressIndicator!
    var statusContainer: NSView!
    var retryTimer: Timer?
    var serverProcess: Process?

    let serverURL = URL(string: "http://localhost:3000")!
    let healthURL = URL(string: "http://localhost:3000/api/state")!
    lazy var projectDir: String = {
        if let envDir = ProcessInfo.processInfo.environment["LUMABRIDGE_DIR"], !envDir.isEmpty {
            return envDir
        }
        let bundleParent = Bundle.main.bundleURL.deletingLastPathComponent().path
        if FileManager.default.fileExists(atPath: (bundleParent as NSString).appendingPathComponent("package.json")) {
            return bundleParent
        }
        return FileManager.default.currentDirectoryPath
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenu()
        setupWindow()
        checkAndConnect()
    }

    func setupMenu() {
        let mainMenu = NSMenu()
        
        // App Menu
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        
        let appName = "LumaBridge"
        appMenu.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthers)
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // View Menu
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenuItem.submenu = viewMenu
        
        let reloadItem = NSMenuItem(title: "Reload", action: #selector(reloadWebView), keyEquivalent: "r")
        viewMenu.addItem(reloadItem)
        let forceReloadItem = NSMenuItem(title: "Force Reload", action: #selector(forceReloadWebView), keyEquivalent: "R")
        viewMenu.addItem(forceReloadItem)
        viewMenu.addItem(NSMenuItem.separator())
        let toggleFull = NSMenuItem(title: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        toggleFull.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(toggleFull)

        // Window Menu
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")

        NSApp.mainMenu = mainMenu
    }

    func setupWindow() {
        let screenSize = NSScreen.main?.visibleFrame.size ?? CGSize(width: 1440, height: 900)
        let initialWidth = min(1280.0, screenSize.width * 0.88)
        let initialHeight = min(840.0, screenSize.height * 0.88)
        let rect = NSRect(x: (screenSize.width - initialWidth) / 2, y: (screenSize.height - initialHeight) / 2, width: initialWidth, height: initialHeight)

        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "LumaBridge"
        window.titleVisibility = .visible
        window.titlebarAppearsTransparent = false
        window.minSize = NSSize(width: 880, height: 600)
        window.delegate = self
        window.backgroundColor = NSColor(calibratedRed: 0.97, green: 0.97, blue: 0.98, alpha: 1.0)

        guard let contentView = window.contentView else { return }

        // Setup WebKit Configuration
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: contentView.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.isHidden = true
        contentView.addSubview(webView)

        // Loading Screen Container
        statusContainer = NSView(frame: contentView.bounds)
        statusContainer.autoresizingMask = [.width, .height]
        contentView.addSubview(statusContainer)

        spinner = NSProgressIndicator(frame: NSRect(x: (initialWidth - 36) / 2, y: initialHeight / 2 + 10, width: 36, height: 36))
        spinner.style = .spinning
        spinner.controlSize = .regular
        spinner.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        spinner.startAnimation(nil)
        statusContainer.addSubview(spinner)

        loadingLabel = NSTextField(frame: NSRect(x: 20, y: initialHeight / 2 - 40, width: initialWidth - 40, height: 30))
        loadingLabel.isEditable = false
        loadingLabel.isBordered = false
        loadingLabel.backgroundColor = .clear
        loadingLabel.alignment = .center
        loadingLabel.textColor = NSColor(calibratedRed: 0.20, green: 0.24, blue: 0.30, alpha: 1.0)
        loadingLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        loadingLabel.stringValue = "Connecting to LumaBridge Service on http://localhost:3000..."
        loadingLabel.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        statusContainer.addSubview(loadingLabel)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func checkAndConnect(attempt: Int = 0) {
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 1.5

        URLSession.shared.dataTask(with: req) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    self.showInterface()
                } else {
                    if attempt == 0 {
                        self.startBackgroundService()
                    }
                    if attempt < 25 {
                        self.loadingLabel.stringValue = "Starting LumaBridge background daemon (attempt \(attempt + 1))..."
                        self.retryTimer = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: false) { [weak self] _ in
                            self?.checkAndConnect(attempt: attempt + 1)
                        }
                    } else {
                        self.spinner.stopAnimation(nil)
                        self.loadingLabel.stringValue = "Could not connect to service at localhost:3000. Run 'npm run dev' in terminal."
                    }
                }
            }
        }.resume()
    }

    func startBackgroundService() {
        // If service is not running, launch it in background
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-l", "-c", "cd '\(projectDir)' && npm run dev"]
        proc.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        
        do {
            try proc.run()
            self.serverProcess = proc
        } catch {
            print("Failed to auto-launch server: \(error)")
        }
    }

    func showInterface() {
        self.retryTimer?.invalidate()
        self.retryTimer = nil
        self.statusContainer.isHidden = true
        self.webView.isHidden = false
        var req = URLRequest(url: serverURL)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        self.webView.load(req)
    }

    @objc func reloadWebView() {
        webView.reload()
    }

    @objc func forceReloadWebView() {
        webView.reloadFromOrigin()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        statusContainer.isHidden = false
        webView.isHidden = true
        loadingLabel.stringValue = "Connection dropped. Reconnecting..."
        spinner.startAnimation(nil)
        checkAndConnect()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        retryTimer?.invalidate()
    }
}

// Entry Point
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = LumaBridgeAppDelegate()
app.delegate = delegate
app.run()
