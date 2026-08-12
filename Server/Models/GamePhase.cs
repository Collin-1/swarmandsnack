namespace SwarmAndSnack.Server.Models;

/// <summary>
/// The game is two states and the moment between them.
///
/// <para><b>Gathering</b> — underlings are on the map and everyone races to eat
/// them. The first player to reach the threshold turns super.</para>
///
/// <para><b>Hunting</b> — every underling leaves the map and the super has two
/// minutes to catch the other leaders. Catch them all and the super wins the
/// match. If anyone is still alive when the clock runs out, the round resets and
/// gathering starts again.</para>
/// </summary>
public static class GamePhase
{
    public const string Gathering = "gathering";
    public const string Hunting = "hunting";
}
