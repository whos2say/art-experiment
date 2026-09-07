using UnrealBuildTool;

public class ResonantSpectra : ModuleRules
{
    public ResonantSpectra(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
        PrivateDependencyModuleNames.AddRange(new string[] { "AudioMixer", "LevelSequence", "MovieScene" });
    }
}
