import SwiftUI
import EACore

/// Settings, Notifications: one switch for each kind of alert, under the hub's own title and line for it. The hub
/// keeps the switches, holds back a kind that is off and tells the other devices over /live; this section only
/// writes them and shows the answer. The notifications this device plans itself (a reminder at its time, the
/// check-in three hours into an activity) follow from the engine's copy of the same list.
struct AlertSwitchesSection: View {
    @EnvironmentObject var engine: SyncEngine
    /// The alerts to list, in the hub's order, those of switched off modules already left out.
    let alerts: [AlertInfo]
    /// Switches flipped here that the hub has not answered yet, so the toggle does not jump back while it waits.
    @State private var pending: [String: Bool] = [:]
    /// A switch that did not change, and why.
    @State private var refused: (id: String, text: String)?

    var body: some View {
        SwiftUI.Section {
            ForEach(alerts) { a in
                Toggle(isOn: binding(a)) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(a.title)
                        if !a.summary.isEmpty { Text(a.summary).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .toggleStyle(.switch)
                .disabled(pending[a.id] != nil)
                // Under the switch that did not change, where the eye already is.
                if let refused, refused.id == a.id {
                    Text(refused.text).font(.caption).foregroundStyle(.warnText)
                }
            }
        } header: {
            Text("Every device")
        }
        .themedRow()
    }

    private func binding(_ a: AlertInfo) -> Binding<Bool> {
        Binding(
            get: { pending[a.id] ?? a.on },
            set: { on in flip(a.id, on) }
        )
    }

    private func flip(_ id: String, _ on: Bool) {
        pending[id] = on
        refused = nil
        Task {
            do { try await engine.setAlerts([id: on]) }
            catch { refused = (id, "Could not save: \((error as? HubError)?.errorDescription ?? error.localizedDescription)") }
            pending[id] = nil
        }
    }
}
