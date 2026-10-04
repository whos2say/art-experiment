#pragma once
#include "Modules/ModuleManager.h"

class FResonantSpectraModule : public IModuleInterface
{
public:
    virtual void StartupModule() override {}
    virtual void ShutdownModule() override {}
};
