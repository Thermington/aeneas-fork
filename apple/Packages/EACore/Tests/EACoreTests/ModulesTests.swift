import XCTest
@testable import EACore

/// Module switches: the list decodes (ids from a newer hub too), unknown means on, and the live event carries the list.
final class ModulesTests: XCTestCase {
    private let list = """
    {"modules": [
      {"id": "renewals", "title": "Renewals and bills", "summary": "Things to renew.", "group": "Plan", "on": true},
      {"id": "homelab", "title": "Homelab", "summary": "Monitors and fix notes.", "group": "Homelab", "on": false},
      {"id": "pet", "title": "Pet", "summary": "Walks and meals.", "group": "Body and home", "on": false},
      {"id": "garden", "title": "Garden", "summary": "Beds and sowing dates.", "group": "Body and home", "on": true, "extra": 1},
      {"id": "web", "title": "Web lookups", "summary": "Searches the web.", "group": "Assistant", "on": true}
    ]}
    """

    func testDecodesTheListInOrderWithIdsTheAppDoesNotKnow() throws {
        let m = try JSONCoding.decode(ModulesResponse.self, from: list).modules
        XCTAssertEqual(m.map(\.id), ["renewals", "homelab", "pet", "garden", "web"])
        XCTAssertEqual(m[1], ModuleInfo(id: "homelab", title: "Homelab", summary: "Monitors and fix notes.", group: "Homelab", on: false))
        XCTAssertNil(AppModule(rawValue: "garden"), "a module from a newer hub still decodes")
        XCTAssertTrue(m.isOn("garden"))
    }

    func testUnknownOrNotLoadedMeansOn() throws {
        let m = try JSONCoding.decode(ModulesResponse.self, from: list).modules
        XCTAssertFalse(m.isOn(.homelab))
        XCTAssertFalse(m.isOn(.pet))
        XCTAssertTrue(m.isOn(.renewals))
        XCTAssertTrue(m.isOn(.films), "a module the hub did not list stays on")
        XCTAssertTrue([ModuleInfo]().isOn(.homelab), "nothing loaded yet: everything shows")
    }

    func testGroupsKeepTheHubsOrder() throws {
        let g = try JSONCoding.decode(ModulesResponse.self, from: list).modules.grouped
        XCTAssertEqual(g.map(\.title), ["Plan", "Homelab", "Body and home", "Assistant"])
        XCTAssertEqual(g[2].modules.map(\.id), ["pet", "garden"])
    }

    func testAThinEntryStillDecodes() throws {
        let m = try JSONCoding.decode(ModuleInfo.self, from: #"{"id": "quiz", "on": false}"#)
        XCTAssertEqual(m, ModuleInfo(id: "quiz", title: "quiz", summary: "", group: "", on: false))
    }

    func testLiveModulesEventCarriesTheWholeList() throws {
        let data = try JSONCoding.string(ModulesResponse(modules: [ModuleInfo(id: "pet", title: "Pet", group: "Body and home", on: false), ModuleInfo(id: "garden", title: "Garden", on: true)]))
        var lines = SSELineBuffer(), parser = SSEParser(), msgs: [SSEMessage] = []
        for b in Array("event: modules\ndata: \(data)\n\n".utf8) { if let l = lines.append(b), let m = parser.feed(line: l) { msgs.append(m) } }
        XCTAssertEqual(msgs.count, 1)
        guard case .modules(let m, let alerts) = HubClient.liveEvent(msgs[0]) else { return XCTFail("not a modules event") }
        XCTAssertEqual(m.map(\.id), ["pet", "garden"])
        XCTAssertFalse(m.isOn(.pet))
        XCTAssertNil(alerts, "a hub from before the alert switches sends none")
    }

    func testOtherLiveEventsAreUnchanged() {
        XCTAssertEqual(HubClient.liveEvent(SSEMessage(event: "change", data: #"{"seq": 4, "id": "t1", "kind": "task"}"#)), .change(seq: 4, id: "t1", kind: .task))
        XCTAssertEqual(HubClient.liveEvent(SSEMessage(event: "ping", data: "{}")), .ping)
        XCTAssertEqual(HubClient.liveEvent(SSEMessage(event: "modules", data: "not json")), .unknown(name: "modules", data: "not json"))
        XCTAssertEqual(HubClient.liveEvent(SSEMessage(event: "later", data: "{}")), .unknown(name: "later", data: "{}"))
    }

    func testClientReadsAndSwitchesModules() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data(list.utf8)), (200, Data(list.replacingOccurrences(of: #""id": "pet", "title": "Pet", "summary": "Walks and meals.", "group": "Body and home", "on": false"#, with: #""id": "pet", "title": "Pet", "summary": "Walks and meals.", "group": "Body and home", "on": true"#).utf8))]
        let c = HubClient(transport: t)
        let before = try await c.modules()
        XCTAssertEqual(t.calls.last?.method, "GET")
        XCTAssertEqual(t.calls.last?.path, "modules")
        XCTAssertFalse(before.isOn(.pet))
        let after = try await c.setModules(["pet": true])
        XCTAssertEqual(t.calls.last?.method, "PUT")
        XCTAssertEqual(t.calls.last?.path, "modules")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: t.calls.last?.body ?? Data()) as? [String: Bool], ["pet": true])
        XCTAssertTrue(after.isOn(.pet))
    }

    func testOffModuleAnswerReadsAsTheHubsSentence() async {
        let t = FakeTransport()
        t.responses = [(404, Data(#"{"error": "Pet is off. Turn it on in Settings, Modules.", "module": "pet"}"#.utf8))]
        do { _ = try await HubClient(transport: t).modules(); XCTFail("expected an error") }
        catch { XCTAssertEqual(error as? HubError, .http(status: 404, message: "Pet is off. Turn it on in Settings, Modules.")) }
    }

    func testCacheRoundTripsThroughSharedConfig() {
        let cfg = SharedConfig(suiteName: "ea-tests-modules")
        XCTAssertNil(cfg.modules)
        XCTAssertTrue(cfg.moduleOn(.homelab), "never fetched: on")
        cfg.modules = [ModuleInfo(id: "homelab", title: "Homelab", group: "Homelab", on: false)]
        XCTAssertFalse(cfg.moduleOn(.homelab))
        XCTAssertTrue(cfg.moduleOn(.pet))
        cfg.modules = nil
        XCTAssertTrue(cfg.moduleOn(.homelab))
    }

    func testKindsBelongToTheHubsModules() {
        XCTAssertEqual(AppModule.of(kind: .application), .jobs)
        XCTAssertEqual(AppModule.of(kind: .incident), .homelab)
        XCTAssertEqual(AppModule.of(kind: .inventory), .projects)
        XCTAssertNil(AppModule.of(kind: .task))
        XCTAssertNil(AppModule.of(kind: .note))
    }

    func testTheHubKeepingCalendarsIsReadFromTheCalendarsModule() throws {
        let json = """
        {"modules": [{"id": "calendars", "title": "Calendar accounts", "summary": "", "group": "Plan", "on": true, "active": true},
                     {"id": "mail", "title": "Mail receipts", "summary": "", "group": "Life admin", "on": true}]}
        """
        let m = try JSONCoding.decode(ModulesResponse.self, from: json).modules
        XCTAssertEqual(m[0].active, true)
        XCTAssertNil(m[1].active, "a module the hub says nothing about has no active")
        XCTAssertEqual(AppModule(rawValue: "calendars"), .calendars)
        XCTAssertTrue(SharedConfig.hubKeepsCalendars(m))
        var off = m; off[0].on = false
        XCTAssertFalse(SharedConfig.hubKeepsCalendars(off), "switched off, the devices take personal events back")
        var idle = m; idle[0].active = false
        XCTAssertFalse(SharedConfig.hubKeepsCalendars(idle), "on but no calendar chosen yet: the devices go on as before")
        XCTAssertFalse(SharedConfig.hubKeepsCalendars(nil))
        XCTAssertFalse(SharedConfig.hubKeepsCalendars([ModuleInfo(id: "renewals", title: "R", on: true)]), "an older hub without the module")
        // Kept in the cache with active, so a launch before the hub answers decides the same way.
        let back = try JSONCoding.decode([ModuleInfo].self, from: try JSONCoding.data(m))
        XCTAssertEqual(back[0].active, true)
    }

    func testTheCalendarsViewDecodes() throws {
        let json = """
        {"accounts": [{"email": "you@icloud.com", "mail": false, "calendars": [{"url": "https://p42-caldav.icloud.com/1/calendars/home/", "name": "Home", "color": "#FF2968", "writable": true, "chosen": true},
          {"url": "https://p42-caldav.icloud.com/1/calendars/holidays/", "name": "Holidays", "writable": false, "chosen": false}],
          "target": "https://p42-caldav.icloud.com/1/calendars/home/", "last_sync": "2026-11-18T22:00:00.000Z", "last_error": null}], "active": true, "results": []}
        """
        let v = try JSONCoding.decode(HubCalendars.self, from: json)
        XCTAssertTrue(v.active)
        XCTAssertEqual(v.accounts.first?.calendars.map(\.name), ["Home", "Holidays"])
        XCTAssertEqual(v.accounts.first?.calendars[1].writable, false)
        XCTAssertNil(v.accounts.first?.last_error)
        XCTAssertEqual(try JSONCoding.decode(HubCalendars.self, from: "{}"), HubCalendars())
    }
}

