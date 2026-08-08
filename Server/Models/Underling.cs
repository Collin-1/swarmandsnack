namespace SwarmAndSnack.Server.Models;

public sealed class Underling : GameEntity
{
    public Underling(string ownerId, Vector2 position, Vector2 velocity)
        : base(ownerId, position, velocity, GameConstants.UnderlingRadius)
    {
    }

    /// <summary>
    /// How long this underling has been stranded beyond its owner's leash.
    /// Steering straight at the owner pins a follower against any wall between
    /// them — measured one sitting 1198px away with a 340px leash — so a
    /// straggler that cannot find its way back is eventually walked home.
    /// </summary>
    public float LostSeconds { get; set; }

    /// <summary>
    /// Freshly spilled food cannot be eaten until this expires, so a rammed
    /// player cannot simply re-swallow its own drop before the attacker reaches
    /// it. Zero for everything else.
    /// </summary>
    public float CoolSeconds { get; set; }
}
